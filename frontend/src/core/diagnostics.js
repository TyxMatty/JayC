// A snapshot of what this app receives and plays, for bug reports from real calls (copied from
// Settings › Troubleshooting). Answers "does their audio arrive?" (packets) and "does it play?"
// (totalAudioEnergy only grows while the audio is played out, see CLAUDE.md).

const inbound = async (consumer) => {
  let found = null;
  (await consumer.getStats()).forEach((s) => {
    if (s.type === 'inbound-rtp') found = { packets: s.packetsReceived ?? 0, bytes: s.bytesReceived ?? 0, energy: s.totalAudioEnergy ?? 0 };
  });
  return found;
};

const trackState = (t) => t && `${t.readyState}${t.muted ? ', muted' : ''}${t.enabled ? '' : ', disabled'}`;

/**
 * @param {{ room: string, micOn: boolean, cameraOn: boolean, micDevice?: string | null, mediaErrors?: object,
 *   participants: Map<string, { name: string, stream: MediaStream, screenStream: MediaStream, consumers: Map<string, { consumer: any, source: string, paused: boolean }> }> }} call
 * @param {{ sampleMs?: number, root?: ParentNode, devices?: () => Promise<MediaDeviceInfo[]> }} [options]
 */
export async function callDiagnostics(call, { sampleMs = 2000, root = document, devices = () => navigator.mediaDevices.enumerateDevices() } = {}) {
  const people = [...call.participants.values()];
  const entries = people.flatMap((p) => [...p.consumers.values()].map((entry) => ({ p, entry })));
  const before = await Promise.all(entries.map(({ entry }) => inbound(entry.consumer)));
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = await Promise.all(entries.map(({ entry }) => inbound(entry.consumer)));
  const seconds = sampleMs / 1000;

  const elements = [...root.querySelectorAll('video, audio')];
  const player = (stream) => {
    const el = elements.find((e) => e.srcObject === stream);
    return el ? { paused: el.paused, muted: el.muted, volume: el.volume, readyState: el.readyState, sinkId: el.sinkId || 'default' } : 'none';
  };

  const outputs = await devices()
    .then((list) => list.filter((d) => d.kind === 'audiooutput').map((d) => d.label || d.deviceId || '(no label)'))
    .catch((error) => [`error: ${error?.name ?? error}`]);

  return {
    time: new Date().toISOString(),
    userAgent: globalThis.navigator?.userAgent,
    room: call.room,
    me: {
      micOn: call.micOn,
      cameraOn: call.cameraOn,
      micDevice: call.micDevice ?? null,
      mediaErrors: call.mediaErrors ?? {},
      // Jay-A mode (docs/JAY-A.md): the link's state and how often Jay-C's filter took over.
      ...(call.jayAStatus ? { jayA: { ...call.jayAStatus, fallbacks: call.jayAFallbacks ?? 0 } } : {}),
    },
    audioOutputs: outputs,
    participants: people.map((p) => ({
      name: p.name,
      player: player(p.stream),
      screenPlayer: p.screenStream.getTracks().length ? player(p.screenStream) : undefined,
      receiving: entries.flatMap(({ p: owner, entry }, i) => {
        if (owner !== p) return [];
        const a = before[i];
        const b = after[i];
        const kind = entry.consumer.kind;
        return [{
          source: entry.source,
          producerPaused: entry.paused,
          track: trackState(entry.consumer.track),
          packetsPerSec: a && b ? Math.round((b.packets - a.packets) / seconds) : null,
          kbps: a && b ? Math.round(((b.bytes - a.bytes) * 8) / 1000 / seconds) : null,
          // Grows only while the sound is actually played out.
          ...(kind === 'audio' && a && b ? { playedEnergy: +(b.energy - a.energy).toFixed(6) } : {}),
        }];
      }),
    })),
  };
}
