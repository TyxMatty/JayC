# Live nativa: captura e codificação fora do WebView (Windows)

**Data:** 2026-11-05 · **Máquina:** Ryzen 5 5600G (6 núcleos, 12 threads), GeForce RTX 3050, monitor 1920×1080 a 180 Hz, Windows 11 (build 26300)
**Código:** [`spikes/native-video`](../../spikes/native-video).
- `main.rs`: captura e liga as peças.
- `encoder.rs`: conversão e codificação na GPU, uma instância por tamanho.
- `ladder.rs`: degraus de qualidade e limite por perda, com testes.
- `webrtc.rs`: envia por WebRTC com a biblioteca [str0m](https://github.com/algesten/str0m) 0.25, com a feature `wincrypto` (a criptografia do próprio Windows, sem OpenSSL).
- `send.mjs`: entra na sala pelo protocolo de sinalização e roda o binário.
- **O servidor não mudou.**

## Pergunta

O usuário pediu uma live "como a do Discord", sem passar pelo Chromium. O Discord também roda em Chromium (Electron); isso é público, não foi medido aqui. A diferença que se pode copiar é capturar e codificar em código nativo. As perguntas deste spike:
- quanto isso ganha;
- se dá para entregar ao mediasoup na mesma porta do app (40000), sem mudar nada para quem hospeda nem para quem assiste.

## Caminho nativo

Tudo fica na placa de vídeo, sem cópia para a CPU:

1. **Windows Graphics Capture** do monitor principal, em textura D3D11 BGRA. `SetIsBorderRequired(false)` foi aceito, então não aparece a borda amarela.
2. **Conversão BGRA → NV12** com o processador de vídeo do D3D11 (`VideoProcessorBlt`).
3. **H.264 High por hardware:** o MFT assíncrono do Media Foundation, que nesta máquina é o "NVIDIA H.264 Encoder MFT", com o `IMFDXGIDeviceManager` do mesmo device.
   - As opções do `ICodecAPI` (baixa latência, CBR, bitrate, GOP) **precisam vir antes de `SetOutputType`**. Depois dele, o MFT da NVIDIA ignora GOP e CBR: saía um quadro-chave a cada ~1,2 s e o bitrate ficava abaixo do pedido.
   - Na ordem certa: 3 quadros-chave em 10 s com GOP de 4 s, e 5,6 Mbps para 6 pedidos.
4. **WebRTC** para o `WebRtcTransport` do mediasoup, pelos mesmos `createTransport` → `connectTransport` → `produce` do app, na porta do `WebRtcServer`:
   - **Conexão:** ICE como lado controlador (o mediasoup é ICE-lite), DTLS como cliente e SRTP.
   - **Perdas:** H.264 com RTX, porque o str0m só reenvia por RTX. PLI e FIR forçam um quadro-chave (`CODECAPI_AVEncVideoForceKeyFrame`).
   - **Banda:** TWCC alimenta a estimativa e o pacer do str0m. O alvo do codificador fica em 85% da estimativa, até o máximo escolhido, e muda por `CODECAPI_AVEncCommonMeanBitRate`.
   - **Quem entra depois:** SPS/PPS são repetidos antes de cada IDR.
   - **Extensões RTP:** usam os IDs padrão do str0m (abs-send-time=2, transport-cc=3, mid=4), declarados iguais no `produce`.

Quem assiste não muda: o app recebe H.264 normal pelo WebRTC e decodifica no WebView.

## Medições

**Método:**
- **Conteúdo:** uma janela de 900×600 redesenha barras e cores ~64 vezes por segundo, em outro processo, porque a captura só entrega quadros quando a imagem muda.
- **CPU:** soma dos processos ao longo de 20–30 s. No nativo, só o próprio processo (`GetProcessTimes`). No WebView, a árvore inteira: `jay-c.exe` (dev) e os processos do `msedgewebview2` do perfil de teste.
- **Configuração da live atual:** 1080p, 60 qps, "motion", tela inteira escolhida pela flag `--auto-select-desktop-capture-source`, microfone desligado.
- **Quem assiste:** o app de dev, **no mesmo PC**, com "Watch stream", medido pelo `inbound-rtp` do consumer.
- **Servidor de teste:** porta 3001, mídia na 40001.

### CPU: live atual × nativa

| | Live atual (WebView2) | Nativa (WebRTC, str0m) |
|---|---|---|
| Codificador | NVIDIA H.264 Encoder MFT (via WebView2) | NVIDIA H.264 Encoder MFT |
| Quadros codificados | 49,3/s | 33–55/s (ver abaixo) |
| CPU total da live | **1,46 núcleo** (1,88 em live − 0,42 na chamada sem live) | **0,04–0,075 núcleo** (até 0,6% da máquina), com o envio |
| Só o vídeo | ~1,32 núcleo (sem os 0,14 do áudio da tela, no `jay-c.exe`) | idem |
| Latência da codificação | não medida | p50 5–6 ms, p95 7–9 ms |

- **Quanto a CPU cai:** cerca de **20 vezes**. O codificador é o mesmo, então o custo do WebView está no caminho até ele: captura, cópias e conversões no processo de GPU, no renderer e no browser.
- **Na live atual, onde vai a CPU:** renderer 0,66, browser 0,47, gpu-process 0,41 e rede 0,09 núcleo. Parte do renderer é a prévia da própria live na tela.

### Quem assiste, sem limite de banda

- **Resultado:** 1920×1080, sem perdas, a 51 quadros/s numa rodada e a 33 em outras duas, com 0–2 congelamentos curtos (até 0,4 s).
- **Estimativa de banda:** subiu sozinha de 1,5 para 6–11 Mbps em poucos segundos.
- **Quadros capturados:**
  - 55/s sem rede e sem ninguém assistindo;
  - 46/s enviando sem ninguém assistindo;
  - 33–36/s com o app de dev decodificando e mostrando a live no mesmo PC.
  - O espectador local (decodificação e desenho de 1080p da própria tela) parece tirar quadros da captura. A causa não foi confirmada; o uso de GPU não foi medido.
- **Versão anterior** (RTP simples num `PlainTransport`, já removida): 55 quadros/s decodificados. Sem retransmissão, congelou até em localhost (439 pacotes perdidos), o que mostrou que reenviar pacotes é obrigatório.

### Banda estreita (simulada)

Não há ferramenta de limitação de rede nesta máquina, então o próprio emissor simula a rede (`JAYC_SHAPE_KBPS`): uma fila de roteador na frente de um upload de 1,5 Mbps, com no máximo 200 ms de espera e descarte acima disso. A fila vale no terço do meio da rodada (12–24 s de 36 s).

- **Estimativa:** caiu de 9,6 para 0,5 Mbps em ~2 s. Durante a limitação ficou em 0,4–1,4 Mbps, e voltou a 7,6–10,8 Mbps 7 s depois de a limitação acabar.
- **Codificador** (registro de uma rodada): o alvo caiu de 6000 para 146 kbps no mesmo instante e subiu em degraus (161, 178 … 1083 kbps). Voltou a 6000 kbps 1 s depois de a estimativa voltar.
- **Quem assiste:**
  - antes: 41–49 quadros/s a 4–5 Mbps;
  - **na queda: um congelamento de 5 s**, com 499 pacotes perdidos. A fila encheu antes de o codificador baixar;
  - durante: 1080p a 0,5–1,1 Mbps, com congelamentos curtos (0,4–1,1 s a cada 3 s).
- **Na última rodada**, você passou a usar o PC (o Discord ficou em primeiro plano) e a captura caiu para 2 quadros/s. Parei as medições aí, e essa rodada não conta.

### Degraus de qualidade (adaptação a redes fracas)

As medições acima eram só de bitrate. Agora a resolução e os quadros/s também acompanham a banda (`ladder.rs`):

| Degrau | Resolução | Quadros/s | Usado a partir de |
|---|---|---|---|
| 0 | 1080p (nunca acima da captura) | 60 (ou o máximo escolhido) | 2500 kbps |
| 1 | 720p | 30 | 1000 kbps |
| 2 | 540p | 30 | 500 kbps |
| 3 | 360p | 15 | abaixo disso |

**Regras:**
- **Orçamento:** o codificador usa 85% da estimativa, sem passar do teto do degrau nem do máximo escolhido.
- **Descer:** na hora, quantos degraus forem precisos.
- **Subir:** um degrau por vez, só depois de 3 s com o orçamento 30% acima do mínimo do degrau de cima.
- **Troca de degrau:** cria um codificador novo no tamanho novo. O primeiro quadro dele é um quadro-chave pequeno, já no tamanho novo. O antigo é encerrado com `ShutdownObject`, porque as GeForce limitam quantas sessões do NVENC ficam abertas.
- **Quadros-chave pedidos (PLI/FIR):** no máximo um por segundo. Na congestão, cada quadro-chave piora a fila.
- **Limite por perda** (a regra do GCC do Google): com mais de 10% de perda nos relatórios do receptor, o orçamento vira `envio × (1 − perda/2)`. Abaixo de 2%, o limite cresce 8% por relatório e some quando passa a estimativa.
  - Motivo: a estimativa pelo atraso chegou a ficar em ~2,7 Mbps num upload de 1,5 Mbps, e 286 pacotes se perderam.

**Medido no emissor** (upload de 1,5 Mbps simulado de 12 a 24 s, sem ninguém assistindo, para a captura não sofrer):
- **Começo:** 720p30, subindo para 1080p60 em 3–6 s.
- **Ao começar a limitação:**
  - O primeiro degrau baixa entre 0,4 e 3 s depois.
  - Ele chega a 360p15 em 0,2–4 s.
  - **Pacotes perdidos: 0, 0 e 53**, contra 499 e 286 só com o bitrate.
  - Em uma rodada, o limite por perda entrou (12% → 1003 kbps).
- **Ao acabar:** volta a 540p 0–6 s depois e a 1080p em 7–12 s, de degrau em degrau.
- **Durante a limitação:** a estimativa desce abaixo do link (0,4–0,5 Mbps num link de 1,5), então fica em 360p15, quando 540p30 caberia. É conservador.

**Não medido de forma confiável: o que quem assiste vê na queda.** Com o espectador no mesmo PC, a captura caiu para 15/s, e o próprio emissor codificou só 11 quadros/s a ~200 kbps, antes mesmo da limitação. Na última rodada você estava usando o PC (o Chrome ficou em primeiro plano). Os números do espectador dessas rodadas (2–29 quadros/s, congelamentos de 0,4 a 3 s) não separam a rede do teste. É preciso um teste em dois PCs.

## No app (05/11/2026)

**Onde está o código:**
- **Rust:** `frontend/src-tauri/src/native_live` (`mod.rs`, `encoder.rs`, `ladder.rs`, `webrtc.rs`).
  - Comandos: `native_live_start`, `native_live_set_quality` e `native_live_stop`.
  - Eventos por um `Channel`: `connected`, `step`, `stats` a cada 2 s, e `ended`.
- **JS:** `core/native-live.js` faz a sinalização (`createTransport`, `connectTransport` e `produce`, num transporte só da live).

**Quando entra:**
- Só em "Tela inteira", com um monitor só (`!screen.isExtended`), e captura o principal.
- Com vários monitores, ou em "Janela", fica o seletor do sistema, até existir o seletor próprio.
- Se o nativo falhar ao começar, a live cai no caminho antigo sem avisar.

**Como funciona:**
- O som da tela continua vindo do plugin `system-audio`, como antes.
- O Settings › Streaming muda o topo dos degraus durante a live.
- O card local mostra "Ao vivo · sem prévia", porque não há faixa local para mostrar.
- `call.screenStats()` devolve os números do Rust.
- O botão do painel passou a se chamar "Entrar ao vivo", já que não há o que escolher.

**Medido no app** (perfil de teste, servidor de teste, mic desligado):
- **CPU da árvore inteira:**
  - Release com a live nativa: 0,68–0,72 núcleo.
  - Dev: 0,75 núcleo. Na chamada sem live, 0,42.
  - Live antiga: 1,88 núcleo.
  - Ou seja, a live (com o som da tela) custa ~0,3 núcleo, contra ~1,46.
- **Quem assiste:**
  - Um segundo participante na mesma página, ou o app de dev assistindo o release, recebeu 1080p com som, sem perdas.
  - Mas só 9,5–11,7 quadros/s. Os números do Rust mostraram que **a própria captura entregava 0–49 quadros/s, variando muito**, com a animação rodando a 64/s. O codificador acompanhava a captura e a estimativa de banda ficou em 9–12 Mbps.
- **A proteção de captura não explica:** desligar o `setContentProtected` (`WDA_EXCLUDEFROMCAPTURE`) não mudou o padrão. Deu 30–49 numa rodada e 0–5 na seguinte.
- **O mais provável é você estar usando o PC:** nas rodadas ruins, o Discord estava em primeiro plano. No spike, com o PC parado, a mesma captura deu 33–55.
- **Falta medir** a taxa de quadros da live no app com o PC parado, ou num segundo PC.

## O que ainda falta para virar a live do app

- **Banda estreita:**
  - Medir quem assiste num segundo PC, com perda e atraso reais (VPN, ou um limitador de verdade).
  - Ajustar os mínimos dos degraus: hoje desce até 360p15 num link de 1,5 Mbps.
- **Codificador:**
  - Só foi testado na NVIDIA. Intel e AMD têm MFTs próprios.
  - Sem nenhum MFT de hardware, seria preciso o codificador de software (o MFT da Microsoft), com custo de CPU ainda não medido.
- **Taxa de quadros no app:** medir com o PC parado ou num segundo PC (ver "No app").
- **Prévia da própria live:** hoje não há.
- **Ainda não feito:**
  - Captura de janela (`CreateForWindow`) e o seletor próprio, com miniaturas.
  - Monitor diferente do principal, e janela redimensionada ou minimizada.
  - Cursor e HDR.
  - O áudio da tela pelo mesmo transporte (hoje vai pelo WebView, a partir do plugin).
  - Prévia da própria live e sincronia A/V.
- **Fora do escopo:** quem assiste continua decodificando no WebView, e não foi comparado com a decodificação nativa.

## Conclusão

Vale seguir com WebRTC nativo na porta 40000:
- **CPU:** a live nativa custa ~0,05 núcleo, contra ~1,3 da atual.
- **Servidor e protocolo:** não mudam.
- **Quem hospeda e quem assiste:** nada muda.
- **Banda:** numa rede estreita, ela baixa resolução e quadros/s em segundos, quase sem perder pacotes, e volta sozinha.

Integrada ao app em 05/11/2026 (ver "No app"). O próximo passo é o seletor próprio, com miniaturas e vários monitores. O teste de quem assiste fica para um segundo PC.
