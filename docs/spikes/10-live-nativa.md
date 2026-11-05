# Live nativa: captura e codificação fora do WebView (Windows)

**Data:** 2026-11-05 · **Máquina:** Ryzen 5 5600G (6 núcleos, 12 threads), GeForce RTX 3050, monitor 1920×1080 a 180 Hz, Windows 11 (build 26300)
**Código:** [`spikes/native-video`](../../spikes/native-video). O `main.rs` captura e codifica, o `rtp.rs` envia, e o `send.mjs` entra na sala pelo protocolo de sinalização e roda o binário. No servidor, `createTransport` aceita `plain: true` ([`sfu-room.js`](../../signaling-server/src/sfu-room.js)).

## Pergunta

O usuário pediu uma live "como a do Discord", sem passar pelo Chromium. O Discord também roda em Chromium (Electron); isso é público, não foi medido aqui. A diferença que se pode copiar é capturar e codificar em código nativo. A pergunta deste spike é quanto isso ganha e se dá para entregar ao mediasoup sem mudar quem assiste.

## Caminho nativo

Tudo fica na placa de vídeo, sem cópia para a CPU:

1. **Windows Graphics Capture** do monitor principal, em textura D3D11 BGRA. `SetIsBorderRequired(false)` foi aceito, então não aparece a borda amarela.
2. **Conversão BGRA → NV12** com o processador de vídeo do D3D11 (`VideoProcessorBlt`).
3. **H.264 High por hardware:** o MFT assíncrono do Media Foundation, que nesta máquina é o "NVIDIA H.264 Encoder MFT", com o `IMFDXGIDeviceManager` do mesmo device.
4. **RTP** (RFC 6184: NAL única ou FU-A, 1200 bytes) por UDP, num `PlainTransport` do mediasoup (comedia, RTCP no mesmo porto).
   - Um PLI ou FIR do servidor força um quadro-chave (`CODECAPI_AVEncVideoForceKeyFrame`).
   - Um NACK reenvia o pacote, a partir de um histórico de 2048.
   - SPS/PPS são repetidos antes de cada IDR, para quem entra depois.

Quem assiste não muda: o app recebe H.264 normal pelo WebRTC e decodifica no WebView.

## Medições

**Método:**
- **Conteúdo:** uma janela de 900×600 redesenha barras e cores sem parar, em outro processo, porque a captura só entrega quadros quando a imagem muda. A janela rodou a ~64 quadros/s (2558 em 40 s).
- **CPU:** soma dos processos ao longo de 20–30 s. No nativo, só o próprio processo (`GetProcessTimes`). No WebView, a árvore inteira: `jay-c.exe` (dev) e os processos do `msedgewebview2` do perfil de teste.
- **Configuração da live atual:** 1080p, 60 qps, "motion", tela inteira escolhida pela flag `--auto-select-desktop-capture-source`, microfone desligado.
- **Quem assiste:** o app de dev, com "Watch stream", medido pelo `inbound-rtp` do consumer.

| | Live atual (WebView2) | Nativo |
|---|---|---|
| Codificador | NVIDIA H.264 Encoder MFT (via WebView2) | NVIDIA H.264 Encoder MFT |
| Quadros codificados | 49,3/s | 55,1/s |
| Bitrate | 1,2 Mbps | 4,9 Mbps |
| CPU total da live | **1,46 núcleo** (1,88 em live − 0,42 na chamada sem live) | **0,068 núcleo** (0,6% da máquina) |
| Só o vídeo | ~1,32 núcleo (sem os 0,14 do áudio da tela, no `jay-c.exe`) | 0,068 (inclui o RTP) |
| Latência da codificação | não medida | p50 5,1 ms, p95 6,7 ms |

- **Quanto a CPU cai:** cerca de **20 vezes**, e o nativo ainda entregou mais quadros e mais bitrate. O codificador é o mesmo, então o custo do WebView está no caminho até ele: captura, cópias e conversões no processo de GPU, no renderer e no browser.
- **Na live atual, onde vai a CPU:** renderer 0,66, browser 0,47, gpu-process 0,41 e rede 0,09 núcleo. Parte do renderer é a prévia da própria live na tela.
- **Quem assiste, com o nativo e o conteúdo a ~60 Hz:** 1920×1080, **55,3 quadros/s decodificados**, 0 pacotes perdidos e 0 congelamentos em 15 s.
- **Rodadas anteriores:** com uma animação mais lenta, que redesenhava ~30–45 vezes por segundo, o decodificado bateu com o capturado (29,9/s e 44,7/s), sem congelamentos.

**Sem NACK, a primeira rodada foi ruim, mesmo em localhost:**
- O que se viu: 439 pacotes perdidos, 6 quadros/s decodificados e 12,7 s congelados em 15 s.
- O que mudou com o reenvio: 0 perdidos no fim, com 6, 67, 26 e 0 pacotes reenviados por rodada.
- A causa provável são as rajadas de um quadro-chave (~100 pacotes de uma vez) estourando o buffer de recepção UDP, porque o envio nunca falhou (0 erros de `send`). Isso não foi confirmado.

## O que ainda falta para virar a live do app

- **Porta e criptografia:**
  - O `PlainTransport` usa uma porta aleatória, e os amigos só liberam a 3000 e a 40000.
  - Ele aceita RTP de quem mandar o primeiro pacote, sem SRTP.
  - **Duas saídas:** um `PlainTransport` com SRTP numa faixa de portas fixa (mais portas para liberar), ou um cliente WebRTC nativo (ICE + DTLS + SRTP) na mesma porta 40000 do `WebRtcServer`. A segunda não muda nada para quem hospeda, mas dá bem mais trabalho.
- **Controle de banda:** não existe. O bitrate é fixo, sem estimativa (transport-cc/REMB) e sem pacer. Numa VPN com upload fraco, isso trava em vez de baixar a qualidade, e as rajadas de quadro-chave vão precisar de pacer.
- **Codificador:**
  - O tamanho do GOP foi ignorado: saiu um quadro-chave a cada ~1–1,4 s, e não a cada 4 s. Isso custa bitrate.
  - O CBR também pode ter sido ignorado: o bitrate ficou abaixo dos 6 Mbps pedidos.
  - Só foi testado na NVIDIA. Intel e AMD têm MFTs próprios, e sem nenhum MFT de hardware seria preciso um codificador de software (o MFT da Microsoft).
- **Ainda não feito:**
  - Captura de janela (`CreateForWindow`) e o seletor próprio, com miniaturas.
  - Monitor diferente do principal, e janela redimensionada ou minimizada.
  - Cursor, HDR e o áudio da tela pelo mesmo caminho.
  - Prévia da própria live, sincronia A/V e o uso de GPU (não medido).
- **Fora do escopo:** quem assiste continua decodificando no WebView, e não foi comparado com a decodificação nativa.

## Conclusão

Vale seguir. O vídeo da live sai do WebView para um caminho nativo que custa ~0,07 núcleo, contra ~1,3, e quem assiste não muda. O próximo passo é decidir o transporte (SRTP com porta fixa ou WebRTC nativo na 40000) e só então integrar ao app, com o seletor próprio.
