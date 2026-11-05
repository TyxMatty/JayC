//! BGRA capture texture -> NV12 (D3D11 video processor, scaled to the output size) -> hardware
//! H.264 (async Media Foundation MFT), all on the GPU. One instance per output size: a quality
//! step change makes a new one, whose first frame is a keyframe with the new SPS.

use std::mem::ManuallyDrop;

use windows::core::{Interface, Result, GUID};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::VARIANT;

const RING: usize = 4; // NV12 textures the encoder may still be reading

pub struct Output {
    /// Sample time, 100 ns units.
    pub time: i64,
    pub data: Vec<u8>,
    pub keyframe: bool,
}

pub struct Encoder {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub name: String,
    activate: IMFActivate,
    transform: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: Option<ICodecAPI>,
    provides_samples: bool,
    vdevice: ID3D11VideoDevice,
    vcontext: ID3D11VideoContext,
    vp_enum: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    ring: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
    next_slot: usize,
    need: u32,
    _manager: IMFDXGIDeviceManager,
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

impl Encoder {
    /// `input`: the capture size; `width` x `height` (even): what gets encoded.
    pub unsafe fn new(device: &ID3D11Device, input: (u32, u32), width: u32, height: u32, fps: u32, kbps: u32) -> Result<Self> {
        let context = device.GetImmediateContext()?;
        let vdevice: ID3D11VideoDevice = device.cast()?;
        let vcontext: ID3D11VideoContext = context.cast()?;
        let rate = DXGI_RATIONAL { Numerator: fps, Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: input.0,
            InputHeight: input.1,
            OutputFrameRate: rate,
            OutputWidth: width,
            OutputHeight: height,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let vp_enum = vdevice.CreateVideoProcessorEnumerator(&content)?;
        let processor = vdevice.CreateVideoProcessor(&vp_enum, 0)?;
        let nv12_desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
            ..Default::default()
        };
        let mut ring = Vec::new();
        for _ in 0..RING {
            let mut tex = None;
            device.CreateTexture2D(&nv12_desc, None, Some(&mut tex))?;
            let tex = tex.unwrap();
            let view_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC { ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D, ..Default::default() };
            let mut view = None;
            vdevice.CreateVideoProcessorOutputView(&tex, &vp_enum, &view_desc, Some(&mut view))?;
            ring.push((tex, view.unwrap()));
        }

        // First hardware H.264 encoder that takes NV12.
        let input_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
        let output_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input_info),
            Some(&output_info),
            &mut activates,
            &mut count,
        )?;
        assert!(count > 0, "no hardware H.264 encoder");
        let found = std::slice::from_raw_parts_mut(activates, count as usize);
        let activate = found[0].take().unwrap();
        for a in found.iter_mut() {
            drop(a.take());
        }
        CoTaskMemFree(Some(activates as _));
        let mut name = windows::core::PWSTR::null();
        let mut len = 0;
        activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)?;
        let name_str = name.to_string().unwrap_or_default();
        CoTaskMemFree(Some(name.0 as _));

        let transform: IMFTransform = activate.ActivateObject()?;
        transform.GetAttributes()?.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
        let mut token = 0u32;
        let mut manager = None;
        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
        let manager: IMFDXGIDeviceManager = manager.unwrap();
        manager.ResetDevice(device, token)?;
        transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;

        // Before the media types: the NVIDIA MFT ignores GOP and CBR when they come after.
        let codec = transform.cast::<ICodecAPI>().ok();
        if let Some(codec) = &codec {
            let set = |guid: &GUID, v: VARIANT, what: &str| {
                if let Err(e) = codec.SetValue(guid, &v) {
                    eprintln!("  (encoder ignored {what}: {e})");
                }
            };
            set(&CODECAPI_AVLowLatencyMode, VARIANT::from(true), "low latency");
            set(&CODECAPI_AVEncCommonRateControlMode, VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32), "CBR");
            set(&CODECAPI_AVEncCommonMeanBitRate, VARIANT::from(kbps * 1000), "bitrate");
            set(&CODECAPI_AVEncMPVGOPSize, VARIANT::from(fps * 4), "GOP");
        }
        let out_type = MFCreateMediaType()?;
        out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        out_type.SetUINT32(&MF_MT_AVG_BITRATE, kbps * 1000)?;
        out_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        out_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
        out_type.SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps * 4)?;
        transform.SetOutputType(0, &out_type, 0)?;
        let in_type = MFCreateMediaType()?;
        in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        in_type.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        in_type.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        transform.SetInputType(0, &in_type, 0)?;

        let provides_samples = transform.GetOutputStreamInfo(0)?.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0;
        transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
        transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
        let events: IMFMediaEventGenerator = transform.cast()?;
        Ok(Self {
            width,
            height,
            fps,
            name: name_str,
            activate,
            transform,
            events,
            codec,
            provides_samples,
            vdevice,
            vcontext,
            vp_enum,
            processor,
            ring,
            next_slot: 0,
            need: 0,
            _manager: manager,
        })
    }

    pub fn wants_input(&self) -> bool {
        self.need > 0
    }

    /// Handles the encoder's queued events; returns the frames it finished.
    pub unsafe fn poll(&mut self) -> Result<Vec<Output>> {
        let mut out = Vec::new();
        while let Ok(event) = self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
            match event.GetType()? {
                t if t == METransformNeedInput.0 as u32 => self.need += 1,
                t if t == METransformHaveOutput.0 as u32 => {
                    let mut buf = [MFT_OUTPUT_DATA_BUFFER::default()];
                    if !self.provides_samples {
                        let info = self.transform.GetOutputStreamInfo(0)?;
                        let s = MFCreateSample()?;
                        s.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(1 << 20))?)?;
                        buf[0].pSample = ManuallyDrop::new(Some(s));
                    }
                    let mut status = 0;
                    self.transform.ProcessOutput(0, &mut buf, &mut status)?;
                    let sample = ManuallyDrop::take(&mut buf[0].pSample).unwrap();
                    drop(ManuallyDrop::take(&mut buf[0].pEvents));
                    let media = sample.ConvertToContiguousBuffer()?;
                    let (mut ptr, mut len) = (std::ptr::null_mut(), 0u32);
                    media.Lock(&mut ptr, None, Some(&mut len))?;
                    let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
                    media.Unlock()?;
                    out.push(Output {
                        time: sample.GetSampleTime()?,
                        data,
                        keyframe: sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0,
                    });
                }
                _ => {}
            }
        }
        Ok(out)
    }

    /// Scales/converts `capture` into the next NV12 texture and queues it. Call when `wants_input`.
    pub unsafe fn encode(&mut self, capture: &ID3D11Texture2D, time: i64) -> Result<()> {
        let (nv12, out_view) = &self.ring[self.next_slot];
        self.next_slot = (self.next_slot + 1) % RING;
        let in_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC { FourCC: 0, ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D, ..Default::default() };
        let mut in_view = None;
        self.vdevice.CreateVideoProcessorInputView(capture, &self.vp_enum, &in_desc, Some(&mut in_view))?;
        let mut streams = [D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(in_view), ..Default::default() }];
        self.vcontext.VideoProcessorBlt(&self.processor, out_view, 0, &streams)?;
        ManuallyDrop::drop(&mut streams[0].pInputSurface);

        let sample = MFCreateSample()?;
        sample.AddBuffer(&MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, nv12, 0, false)?)?;
        sample.SetSampleTime(time)?;
        sample.SetSampleDuration(10_000_000 / self.fps as i64)?;
        self.transform.ProcessInput(0, &sample, 0)?;
        self.need -= 1;
        Ok(())
    }

    pub unsafe fn set_bitrate(&self, kbps: u32) {
        if let Some(c) = &self.codec {
            let _ = c.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(kbps * 1000));
        }
    }

    pub unsafe fn force_keyframe(&self) {
        if let Some(c) = &self.codec {
            let _ = c.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
        }
    }
}

impl Drop for Encoder {
    /// Frees the hardware session (GeForce cards allow only a few at once).
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.activate.ShutdownObject();
        }
    }
}
