# Jay-C — contexto para o Claude

App leve e open-source de chamadas e transmissão de tela (Tauri v2 + Vanilla JS), com servidor self-hosted (Node + `ws` + SFU mediasoup) em Docker.
- **Arquitetura, decisões, protocolo e etapas:** [docs/ARQUITETURA.md](docs/ARQUITETURA.md). A tabela da seção 10 marca o que está feito (✅).
- **Estado atual, instalação num PC novo e próximos passos:** [docs/CONTINUAR.md](docs/CONTINUAR.md)
- **Medições que embasaram decisões:** [docs/spikes/](docs/spikes/), com a captura por processo e o som abafado

## Como trabalhar com o usuário

- **Idioma:** o usuário escreve em português ou inglês. Responda no idioma da última mensagem dele. Docs e commits ficam em português; código e comentários, em inglês.
- **Commits:** **nunca** inclua `Co-Authored-By: Claude` nem outra atribuição. A mensagem descreve as mudanças (assunto + corpo com o quê e por quê, e o que foi verificado).
- **Ritmo:** planejar antes e avançar **uma etapa por vez**, cada uma terminando em algo testável. Ao fim de cada etapa: commit, resumo e pergunta se segue para a próxima.
- **Verificação:** prove com medição, não com suposição. Se um teste não prova nada (inconclusivo, mic que falhou em silêncio etc.), diga isso. Antes de afirmar algo sobre apps de terceiros (ex.: "o Discord também faz X"), meça ou diga que não mediu.
- **Ações no sistema:** instalações com UAC, configurações do Windows e encerrar processos precisam de cuidado. Antes de encerrar um processo, confira **nome e linha de comando**, não só o PID, porque o Windows reusa PIDs.

## Build e execução (Windows)

```bash
npm install
npm run dev          # app Tauri (abre a janela), com Vite em :5173
npm run server       # servidor de sinalização + SFU (:3000 e mídia em :40000 UDP/TCP)
npm test             # testes do servidor e do frontend (node:test)
```

- **Rust fora do OneDrive:** o repositório fica no OneDrive, então o `target/` vai para outra pasta via `.cargo/config.toml` na raiz. Esse arquivo é local e não vai para o git; recrie-o num PC novo (ver docs/CONTINUAR.md).
- **Python + Meson + Ninja** são necessários. O `build.rs` do plugin `system-audio` compila `third_party/webrtc-audio-processing` com Meson + MSVC numa pasta curta (`<target>/webrtc-apm-2.1`). O primeiro build baixa o abseil e leva alguns minutos.
- **Terminais abertos antes de uma instalação** não enxergam o PATH novo. Recarregue com `scripts/dev-debug.ps1` (ou o trecho de PATH dele).
- **O plugin fica fora da pasta vigiada pelo `tauri dev`:** depois de mudar `plugins/tauri-plugin-system-audio`, reinicie o `npm run dev`.
- **Testar o app real sem clicar:** `scripts/dev-debug.ps1` abre o app com depuração do WebView2 na porta 9222. `node scripts/cdp-eval.mjs teste.js` roda JS dentro do app, com acesso ao plugin nativo e a `window.__jaycCall` (exposto só no modo dev). O seletor de tela (`getDisplayMedia`) precisa de um humano, ou de um canvas falso no teste.
- **Diagnóstico de áudio:** `cargo run --example output_meter` (nível do que sai no alto-falante) e `--example mic_open` (abre o microfone com WASAPI puro), dentro de `plugins/tauri-plugin-system-audio`. `node scripts/make-tone.mjs` gera um tom estéreo de teste.

## Fatos técnicos que custaram para descobrir

- **Microfone no Windows é nativo** (WASAPI + AudioProcessing do WebRTC no plugin), não `getUserMedia`. O mic do WebView2 coloca alguns notebooks (Acer PurifiedVoice / Intel SST) em "modo chamada" e abafa os outros apps em ~65 dB. Ver docs/spikes/09.
- **"Tudo menos o Jay-C" no loopback por processo** exclui a árvore do `msedgewebview2.exe` filho do app, não a do `jay-c.exe`: para o Windows, a árvore do app não inclui o WebView2. Ver docs/spikes/06.
- **Janela escolhida no `getDisplayMedia`:** o rótulo da faixa é `window:<HWND>:0`.
- **Simulcast:** o Chrome só gera as camadas altas se a entrada for grande. Teste com câmera falsa ≥ 1280×720.
- **CSS:** existe a regra global `[hidden] { display: none !important }`, porque componentes com `display` próprio ignoravam `hidden`.
- **AudioWorklet:** o Vite não pode embutir o worklet como `data:` URL, porque a CSP bloqueia (ver `vite.config.js`).
- **AEC3:** para testar, use sinal de banda larga. Tons puros mostram remoção fraca, e o AGC precisa ficar desligado na comparação.
