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

> **Correção (05/11/2026, depois do seletor):** a janela de animação usada como conteúdo **nunca apareceu na tela**. Ela era aberta com `Start-Process -WindowStyle Hidden`, e o formulário do WinForms herdava o "escondido", ficando visível em nome e com área 0×0.
> - **O que deixa de valer:** os números de quadros/s abaixo (capturados, codificados, decodificados) mediram outra coisa que mudava na tela: o app do Claude escrevendo, ou o PC em uso. Isso explica a variação de 0 a 55.
> - **O que vale, mas com cautela:** as comparações de CPU entre a live atual e a nativa. As duas foram medidas com esse mesmo conteúdo desconhecido.
> - **Medição válida de quadros/s:** a do seletor, em "Seletor próprio".

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
- **Explicação:** a janela de animação estava escondida (ver a correção em "Medições"), então a tela quase não mudava. Com uma janela que muda de verdade, a captura acompanha (ver "Seletor próprio").

## Seletor próprio (05/11/2026)

**O que mudou:** em vez do seletor do Chromium, o app tem o dele (`ui/source-picker.js`).
- **Comandos:** `native_live_sources` lista telas e janelas, e `native_live_thumbnail` devolve uma miniatura JPEG de cada uma (`src-tauri/src/native_live/sources.rs`).
- **Miniaturas:** são um quadro do próprio WGC, então janelas desenhadas pela GPU também aparecem. O JPEG é feito pelo WIC, e cada miniatura chega como bytes, sem base64.
- **Lista de janelas:** visíveis, com título, sem minimizar e sem "cloaked" (outras áreas de trabalho, apps UWP suspensos). Ficam de fora janelas de ferramenta, janelas com dono, as menores que 64 px e o próprio Jay-C.
- **Limites que saíram:** a live nativa aceita qualquer monitor ou janela. A restrição de "um monitor só" acabou.
- **Seletor do sistema:** continua só fora do Windows, ou quando o nativo falha.

**Live de uma janela:**
- **Redimensionar:** o pool de quadros e o codificador são recriados no tamanho novo.
- **Fechar a janela:** a live termina com "A live parou: a janela foi fechada".
- **Minimizar:** a janela não gera quadros enquanto estiver minimizada.
- **Som:** vem do processo da janela, pelo HWND, como antes.

**Medido no app (dev):**
- **Lista e miniaturas:** a lista aparece em ~105 ms. As miniaturas de 10–11 fontes ficam prontas em 0,6–0,8 s, em paralelo (~210 ms cada; 390 ms a do monitor; 7–20 KB).
- **Layout:** o diálogo tem 760 px, 3 colunas, sem rolagem lateral, e o foco começa na primeira opção.
- **Uma janela de animação visível**, 886×592, redesenhando ~64 vezes por segundo, compartilhada pelo seletor:
  - **No envio:** **56–59 quadros/s capturados e codificados por 12 s seguidos**, a 886×592@60, com 5,1–5,4 Mbps e estimativa de 11–12 Mbps.
  - O som veio de `powershell.exe`, o dono da janela.
  - Fechar a janela encerrou a live com o aviso certo.
- **Tela inteira pelo seletor:** começa em 720p30 e sobe para 1920×1080@60, com estimativa de ~10 Mbps. "Opções da live" → "Parar a live" encerra a live sem avisos nem erros, e o card some.
- **Quem assiste a janela** (um segundo participante na mesma página): recebeu 886×592 a 18,8 quadros/s, sem perdas. Mas no meio da medição a janela de animação foi minimizada (o PC estava em uso), e o envio caiu para 0. Então esse número também não vale.
- **Falta:** medir quem assiste com o PC parado, ou em outro PC.

## Correções da revisão de código (05/11/2026)

Uma revisão do código inteiro apontou problemas na live nativa. Os principais foram corrigidos e testados no app de dev:
- **Tela parada:** a captura só entrega quadros quando a imagem muda. Antes, quem começava a assistir uma tela parada não via nada até algo mexer. Agora o último quadro fica guardado e é reenviado no mínimo a cada 1 s, e na hora quando é preciso um quadro-chave. Medido com uma janela parada: 0 quadros/s capturados, 1/s enviado, e quem começou a assistir 6 s depois recebeu a imagem em 0,7 s.
- **Pedidos de quadro-chave** que chegam menos de 1 s depois do último ficam esperando a vez, em vez de serem descartados.
- **Queda de rede:** o "disconnected" do ICE pode voltar sozinho; a live só termina depois de 20 s sem o servidor. Se a sinalização reconecta (servidor reiniciado), a live recomeça sozinha num transporte novo. Medido: servidor reiniciado no meio da live, reconexão em ~7 s, live de volta sem aviso, e um participante novo recebeu 1080p.
- **Transporte:** a live fecha o próprio transporte no servidor ao parar (`closeTransport`, novo no protocolo). Um servidor antigo não conhece o pedido; aí o transporte fica até a pessoa sair, como antes.
- **Parar durante o início:** a live fica registrada antes de estar pronta, então sair da chamada enquanto ela começa a para de verdade (antes, a captura seguia por até ~15 s).
- **Erros do codificador** (GPU reiniciada, dispositivo removido) agora encerram a live com aviso, em vez de congelar a imagem sem dizer nada.
- **Visto uma vez, não reproduzido:** ao recomeçar depois de uma reconexão, o codificador falhou ao abrir (`MF_E_UNSUPPORTED_D3D_TYPE`) no mesmo segundo em que o Windows invalidou o microfone. O recomeço agora tenta de novo 1 s depois e, se falhar, avisa.

## A própria live no card de quem transmite (05/11/2026)

O card "Sua tela" mostrava "Ao vivo · sem prévia" (a live nativa não tem faixa local), depois uma imagem a cada 2 s. Agora mostra a live de verdade:
- **Como:** o Rust entrega à página os mesmos quadros H.264 que manda pela rede (`native_live_watch`, por um `Channel` do Tauri: tempo, se é quadro-chave e os dados Annex B), e o WebCodecs (`VideoDecoder`) decodifica na placa de vídeo e desenha num `<canvas>`. Nada passa pela rede. Ao começar, o Rust força um quadro-chave, porque um decodificador só começa num. `Sender::complete` põe SPS/PPS nos quadros-chave, para a rede e para o card.
- **Medido** (janela de teste a ~50 quadros/s, 886x592, app de dev):
  - o card desenha o tamanho inteiro (886x592) e todos os quadros que chegam (53,2 decodificados e desenhados por segundo, com 53 codificados; fila do decodificador vazia);
  - custo: 1,31 núcleo com o card contra 1,11 sem ele (mesma live), quase tudo no processo de GPU do WebView2 (0,20 contra 0,03); o Rust não muda.
- **Minimizado:** com o app minimizado, o card para de decodificar (`native_live_unwatch`) e volta num quadro-chave ao restaurar. O WebView2 não marca a página como `hidden` com a janela minimizada (medido), então o card pergunta à janela do Tauri (`isMinimized`, a cada 1 s). Medido: 0 quadros desenhados minimizado, processo de GPU de 0,32 para 0,04 núcleo; de volta ao restaurar.
- **Canal novo a cada registro:** o Tauri desregistra o callback de um `Channel` quando o Rust solta a última cópia. Reaproveitar o canal depois de um `unwatch` deixava o card parado (medido: 0 quadros depois de restaurar).
- **A sala** continua recebendo uma imagem pequena a cada 6 s (`screen-preview`), agora só para o card "Assistir live".

**Dois bugs achados nesses testes:**
- **Janela compartilhada minimizada encerrava a live.** Minimizada, a captura informa o tamanho da barra de título (146x28); a live recriava o codificador nesse tamanho, a GPU recusava (`MF_E_UNSUPPORTED_D3D_TYPE`, 0xC00D6D76) e a live acabava. É provável que seja a falha "vista uma vez" acima. Agora tamanhos abaixo de 64 px (`MIN_SIDE`, o mesmo piso do seletor) são ignorados: o último quadro segue saindo. Medido: minimizada, 0 quadros capturados e 1/s enviado, e o card continua; restaurada, volta a ~52/s.
- **Depois de uma live que acaba sozinha** (janela fechada, erro da GPU), a próxima era recusada pelo servidor (`duplicate-source`) e o app caía no seletor do sistema (o do Chromium): o transporte da live antiga não era fechado. Agora é. Medido: janela A fechada, live de B começou nativa, sem avisos.

## O que ainda falta para virar a live do app

- **Banda estreita:**
  - Medir quem assiste num segundo PC, com perda e atraso reais (VPN, ou um limitador de verdade).
  - Ajustar os mínimos dos degraus: hoje desce até 360p15 num link de 1,5 Mbps.
- **Codificador:**
  - Só foi testado na NVIDIA. Intel e AMD têm MFTs próprios.
  - Sem nenhum MFT de hardware, seria preciso o codificador de software (o MFT da Microsoft), com custo de CPU ainda não medido.
- **Quem assiste:** medir os quadros/s recebidos com o PC parado, ou num segundo PC.
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

Integrada ao app em 05/11/2026 (ver "No app"), com o seletor próprio (ver "Seletor próprio"). O teste de quem assiste fica para um segundo PC.

## Engasgos, texto ilegível e a escada (07/11/2026)

**Relato:** "as lives continuam tendo um gargalo enorme", texto quase ilegível durante a live (print de um jogo, do lado de quem assiste) e o som um pouco atrasado. Servidor remoto, pelo Radmin VPN.

**O log do app instalado** (live de um jogo numa janela de 1906×1073, 60 quadros/s escolhidos):
- a live pulava entre 720p30 (1,2–2,5 Mbps) e 1080p60 (3,5–7,5 Mbps), voltando 1–4 s depois de cada subida;
- três vezes, "WebRTC: lost the connection to the server" logo depois de uma troca, e a live recomeçou.

### Reprodução

- **Montagem:** app de dev; uma janela de teste de 1920×1080 com 60% em movimento e um HUD de texto pequeno; quem assiste num Chrome sem janela; um limitador de UDP de 4 Mbps com fila de 200 ms (`scripts/udp-shaper.mjs`).
- **Cenário 1, upload de quem transmite em 4 Mbps:**
  - a live repetiu o padrão do log: 720p30 → 1080p60 → 720p30, e depois ficou presa em 720p30;
  - **em 1080p60, o atraso foi de ~0,2 s para 1,5–1,7 s**, com perdas e pausas de 1,1 e 1,4 s;
  - **quem prendeu a live em 720p30:** o teto do espectador (70% da estimativa do mediasoup), com o espectador sem limite nenhum. O log dizia `budget 2351 (estimate 2999, viewers 2351…)`;
  - **o texto:** em 1080p60 a ~3,5 Mbps o HUD ficou quase ilegível, pior que em 720p30 a 2,5 Mbps (3× menos bits por pixel).

### As causas, medidas uma a uma

1. **Quadros-chave enormes.** Medido no codificador da NVIDIA, fora do app, a 1080p30 e 3 Mbps: cada quadro-chave do GOP de 4 s tinha 300–500 KB, 57–95× um quadro comum (5,3 KB), ou 1–1,3 s do link inteiro. A cada 4 s, uma rajada que enchia a fila do roteador e derrubava a estimativa de banda.
2. **A fila do str0m.** Ele envia a 1,1× a estimativa e só esvazia a fila à força depois de 2 s. Quando o codificador produz mais do que isso, o atraso cresce até ~2 s (os 1,5 s medidos).
3. **A thread da live esperando CPU.** Com o PC ocupado e a thread na prioridade normal, o `sleep` de 1 ms durou até 27 ms (p99) e 97 ms (máx.). Registrada no MMCSS ("Capture"), no máximo 2 ms. Um jogo na frente piora isso.
4. **Um codificador novo a cada degrau:** 67–290 ms com a thread parada, e um quadro-chave novo.

**O codificador, medido fora do app** (NVIDIA, 1080p30, 3 Mbps; um programa à parte com uma cópia do `encoder.rs`, alimentado com uma imagem parecida com a da janela de teste):

| Ajuste | Quadro-chave | Corte de cena | kbps por segundo |
|---|---|---|---|
| antes (GOP de 4 s, buffer padrão) | 303–503 KB | — | 1,5–5,4 Mbps |
| sem GOP periódico | 303 KB (só o primeiro e os pedidos) | 203–440 KB | 1,6–5,0 |
| sem GOP + buffer de 100 ms | 228 KB | 172–226 KB | 2,3–3,6 |
| **sem GOP + buffer de 50 ms** | **96–122 KB** | **116–145 KB** | **2,1–3,1** |
| sem GOP + buffer de 33 ms | 91–112 KB | — | o codificador travou |

- O refresh gradual (`AVEncVideoGradualIntraRefresh`) não existe no codificador da NVIDIA ("Parâmetro incorreto"). O piso de QP não mudou o tamanho do quadro-chave.
- Com buffer menor que 1,5 quadro, o codificador não chega no bitrate (15 quadros/s com 50 ms: 2,0–2,45 Mbps para 3).
- Um codificador de 30 quadros/s alimentado com 15 entrega ~0,43× o bitrate: ele divide o bitrate pelos quadros configurados. Trocar os quadros/s sem recriar o codificador exigiria compensar isso; ficou de fora.
- Mudar o bitrate com o codificador rodando funciona (3000 → 1500 kbps: de ~2,6 para ~1,2–1,4 Mbps).

### O que mudou (`src-tauri/src/native_live`)

- **Codificador:** quadro-chave só quando pedido (um PLI de quem assiste, o servidor quando alguém começa a assistir, um codificador novo). O buffer do controle de taxa fica em 50 ms do bitrate, ou 1,5 quadro se for mais, e acompanha o bitrate.
- **Escada (`ladder.rs`):** os degraus saem da qualidade escolhida e do "Otimizar para":

  | Otimizar para | Degraus (com 1080p60 escolhido) |
  |---|---|
  | Texto (padrão) | 1080p60 → 1080p30 → 1080p15 → 720p15 → 540p10 → 360p10 |
  | Movimento | 1080p60 → 720p60 → 720p30 → 540p30 → 360p30 → 360p15 |

  - **Mínimo de cada degrau:** 0,04 bit/pixel/quadro. Os quadros acima de 30/s contam pela metade, como no `media.js`.
  - **Teto de cada degrau:** chega a 30% acima do mínimo do degrau de cima. Assim, antes de subir, a live já envia o que o degrau de cima precisa: a subida muda o tamanho da imagem, não o bitrate.
  - **Descer:** depois de 2 s abaixo do mínimo, ou na hora abaixo de 80% dele.
  - **Subir:** um degrau por vez, depois de 3 s com 30% de folga. Cada descida dobra essa espera (×4 se a subida não durou 20 s), até 2 min; um minuto sem descer a corta pela metade. No log real, o teto de 30 s ainda dava um engasgo a cada 30 s.
- **Fila de envio:** medida como os bytes entregues ao str0m menos os que ele diz ter enviado.
  - De 40 a 120 ms de fila, o codificador recebe menos bitrate (até a metade).
  - Acima de 150 ms, um quadro a cada dois fica de fora; acima de 300 ms, todos. Isso vale até a fila voltar a 80 ms. Pular todos de uma vez dava uma pausa de ~230 ms a cada ~10 s.
  - Se isso dura (cerca de 1/5 do tempo) com o orçamento dizendo que o degrau cabe, desce um degrau.
- **Quem assiste:** o limite é 70% da mediana das 3 últimas leituras do servidor (a cada 2 s), seguindo para baixo na hora e subindo no máximo 15% por leitura. Com ninguém assistindo, a live fica em 2 Mbps, e o primeiro espectador começa daí. A estimativa do mediasoup não é a capacidade:
  - **parada:** fica no mesmo valor enquanto a live envia menos (3954 kbps por 40 s);
  - **acima do link:** sobe 15–30% acima do link antes de cair (4,6–5,2 Mbps num link de 4). Com 85% dela, a live perdeu até 722 pacotes em 5 s e passou 33 s de 170 em pausa;
  - **leitura falsa:** uma vez leu 100 kbps para quem tinha acabado de entrar.
- **A thread da live** fica registrada no MMCSS ("Capture").
- **Para diagnóstico:**
  - A linha de troca de degrau no log diz o que segurou o orçamento (`estimate`, `viewers`, `loss limit`) e quanto levou para criar o codificador.
  - O `call.screenStats()` ganhou `budgetKbps`, `skippedFps`, `queueMs`, `loopMaxMs` e `frameGapMaxMs`.

### Medido depois (mesma montagem, ~160 s cada)

| Cenário | Antes | Depois |
|---|---|---|
| Upload de 4 Mbps | 720p30 ↔ 1080p60, presa em 720p30; atraso até 1,7 s; pausas de 1,1–1,4 s | 1080p30 o tempo todo (3,8 Mbps); 0 pacotes perdidos para o app; atraso mediano 167 ms, máx. 422; 4 pausas de 200–270 ms (pacotes descartados no limitador e reenviados) |
| Quem assiste num link de 4 Mbps | 720p30 depois de ~8 s engasgando (commit `ef26b76`) | 1080p15 o tempo todo; 2 tentativas de subir que não seguraram (167 pacotes perdidos no total, pausas de até 0,44 s); atraso mediano 156 ms |
| Sem limite | 1080p60, 37–58 quadros/s | 1080p60 em ~40 s e dali até o fim; 51 quadros/s; 0 perdas; atraso de 66 ms (máx. 84) |

O texto do HUD em 1080p30 a ~3,7 Mbps ficou legível linha a linha, onde o 1080p60 a ~3,5 Mbps de antes era um borrão.

**Limites:**
- **Rede:** um limitador no mesmo PC, com fila de 200 ms. A rede real do relato (Radmin VPN) não foi medida, e o motivo das quedas da sinalização no log não foi achado.
- **Codificador:** só a NVIDIA foi medida.
- **Troca de degrau:** cada uma ainda cria um codificador (67–290 ms, mais um quadro-chave).
- **Espectador num link lento:** ele ainda tenta subir de vez em quando, e a espera cresce a cada tentativa que falha.
- **O som atrasado** é a próxima etapa.
