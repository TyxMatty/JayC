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
- **O app e o servidor abertos podem ser do usuário:** se as portas 5173/3000 estiverem ocupadas, pergunte antes de fechar qualquer coisa. Testes que mexem nas configurações (tema, sala, foto, barra) devem guardar e restaurar os valores do usuário. Screenshot da tela inteira pega coisas pessoais: recorte para a área do app e apague depois.

## Build e execução (Windows)

```bash
npm install
npm run dev          # app Tauri (abre a janela), com Vite em :5173
npm run server       # servidor de sinalização + SFU (:3000 e mídia em :40000 UDP/TCP)
npm test             # testes do servidor e do frontend (node:test)
npm run build        # instalador Windows de release (NSIS), ~7–9 min
```

- **Rust fora do OneDrive:** o repositório fica no OneDrive, então o `target/` vai para outra pasta via `.cargo/config.toml` na raiz. Esse arquivo é local e não vai para o git; recrie-o num PC novo (ver docs/CONTINUAR.md).
- **Python + Meson + Ninja** são necessários. O `build.rs` do plugin `system-audio` compila `third_party/webrtc-audio-processing` com Meson + MSVC numa pasta curta (`<target>/webrtc-apm-2.1`). O primeiro build baixa o abseil e leva alguns minutos. O Meson roda **sem pkg-config** (`PKG_CONFIG` aponta para nada): o do MSYS2, se estiver no PATH, pode estar quebrado ou trazer bibliotecas MinGW.
- **npm 12 bloqueia scripts de instalação.** O `allowScripts` do `package.json` libera o do mediasoup. Se os testes do servidor falharem com `mediasoup-worker ENOENT`, rode `npm rebuild mediasoup`.
- **Mudou o servidor? Reinicie o `npm run server`.** Ele não recarrega sozinho, e um servidor antigo com o app novo recusa mensagens novas (ex.: `profile`).
- **Instalador com template NSIS próprio:** `frontend/src-tauri/windows/installer.nsi` é o template do `tauri-cli` 2.12.4 com três blocos a mais, marcados "Jay-C:": em `PageReinstall`, versão mais velha instalada = atualiza por cima, sem a página "desinstalar antes"; e `MUI_LANGDLL_ALWAYSSHOW`, para o seletor de idioma aparecer mesmo numa atualização (sem ele, o idioma lembrado da instalação anterior pula a pergunta). E as cores do estilo Suave (`MUI_BGCOLOR`/`MUI_TEXTCOLOR`). As imagens da lateral e do topo (`windows/installer-sidebar.bmp` e `installer-header.bmp`, BMP 24 bits) saem de `node scripts/installer-art.mjs`, que as desenha dentro do app de dev (precisa da Inter carregada). **Ao atualizar o `@tauri-apps/cli`**, baixe o template da tag nova (`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`) e reaplique os blocos; um template velho com um bundler novo pode quebrar o build ou o instalador.
- **Ícone (o lobo do Jay-C):** a fonte é o desenho do usuário, `frontend/src-tauri/app-icon-lineart.png` (traço de uma cor, fundo transparente, 1024 px). O traço some em 16–32 px, então o ícone é a "cabeça preenchida": `powershell -File scripts/wolf-icon.ps1` engrossa o traço (pincel redondo), acha o interior da cabeça e gera duas máscaras (`frontend/src/assets/brand/wolf-lines.png` e `wolf-fill.png`) e o `src-tauri/app-icon.png`, no laranja Suave sobre a cabeça `#16131B`. O app pinta as máscaras com as cores do estilo: na marca do topo e do lobby (CSS `mask`, classe `.wolf-mark`), no ícone da janela (`ui/window-icon.js`, sempre nas cores escuras do estilo, `ICON_COLORS` em `core/style.js`) e nas imagens do instalador. Depois, `npx tauri icon src-tauri/app-icon.png` (em `frontend/`) gera todos os tamanhos, inclusive os do Android; depois volte a cor de fundo do ícone adaptativo (`gen/android/.../values/ic_launcher_background.xml`) para `#16131B`, porque o comando põe branco. **O `jay-c.exe` só pega um ícone novo se o `build.rs` rodar de novo:** mude a data dele antes do `npm run build`, senão o Cargo reaproveita o recurso antigo. O instalador usa `installerIcon` do `tauri.conf.json`.
- **Não rode o instalador no PC do usuário com o Jay-C dele instalado**, nem só para fotografar: com textos próprios na página de boas-vindas (`MUI_WELCOMEPAGE_TITLE/TEXT` via LangString), o instalador 0.2.4 passou sozinho pelas páginas e instalou por cima, fechando o app aberto (as configurações ficaram). A causa não foi confirmada; o texto foi tirado. Teste instalador numa máquina ou conta de teste.
- **Terminais abertos antes de uma instalação** não enxergam o PATH novo. Recarregue com `scripts/dev-debug.ps1` (ou o trecho de PATH dele).
- **O plugin fica fora da pasta vigiada pelo `tauri dev`:** depois de mudar `plugins/tauri-plugin-system-audio`, reinicie o `npm run dev`.
- **Testar o app real sem clicar:** `scripts/dev-debug.ps1` abre o app com depuração do WebView2 na porta 9222. `node scripts/cdp-eval.mjs teste.js` roda JS dentro do app, com acesso ao plugin nativo e a `window.__jaycCall` (exposto só no modo dev). O seletor de tela (`getDisplayMedia`) precisa de um humano, ou de um canvas falso no teste.
  - **Gesto do usuário:** o `cdp-eval` manda `userGesture: true`, e isso basta para PiP e popovers. Mas o gesto é consumido: um segundo `request*` no mesmo script falha.
  - **Módulos editados com o Vite rodando** passam a ser importados como `arquivo.js?t=…`. Um `import('/src/store/settings.js')` no teste cria **outra instância**, desconectada do app. Use a URL que o app carregou: `performance.getEntriesByType('resource')`.
  - **PowerShell 5.1 estraga aspas** de JS passado como argumento para o `node`. Passe o JS num arquivo.
  - **Live real sem clicar no seletor:** acrescente `--auto-select-desktop-capture-source="Tela inteira"` ao `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. O nome segue o idioma do Windows (em inglês, "Entire screen"). Para ter quadros novos, algo precisa mexer na tela: a captura só entrega quadros quando a imagem muda.
  - **Contraste na tela de verdade:** `node scripts/cdp-eval.mjs scripts/contrast-audit.js` mede o contraste de cada texto visível contra o fundo real atrás dele (compondo camadas translúcidas) e lista o que fica abaixo de 4,5:1 (3:1 para texto grande). Pula texto sobre vídeo, imagem ou degradê. Para uma tela estreita, use `Emulation.setDeviceMetricsOverride` do CDP na mesma conexão (ele some quando a conexão fecha).
  - **Arraste e clique reais:** `Input.dispatchMouseEvent` do CDP gera pointer events de verdade.
  - **Segundo participante:** um `new Call()` na mesma página, com `getUserMedia`/`getDisplayMedia` trocados por canvas, entra na sala como "bot".
  - **Bot com som próprio:** rode-o numa página separada (o painel do navegador em `http://localhost:5173`, fora do Tauri), com `getUserMedia` trocado por um oscilador. Um bot dentro do app usa o **microfone nativo**, que é um só por processo: quando o app entra, o bot fica mudo. O `__TAURI_INTERNALS__.invoke` não pode ser trocado para evitar isso.
  - **"Ele ouve?" se mede no alto-falante** (`output_meter`), não na faixa recebida. O `totalAudioEnergy` do `inbound-rtp` só cresce enquanto o som toca. O diagnóstico do app (Settings › Troubleshooting) usa isso.
  - **Não encerre o app de dev à força logo depois de mudar configurações:** o `localStorage` do WebView2 vai para o disco com atraso e se perde. Restaure, espere ~20 s, e feche com `CloseMainWindow()`.
  - **Servidor de teste sem mexer no do usuário:** `PORT=3001 RTC_PORT=40001 node src/server.js` em `signaling-server/`.
- **Android:** `scripts/android-dev.ps1` (precisa do Modo de Desenvolvedor do Windows, por causa dos symlinks). Rode-o pela ferramenta PowerShell em segundo plano, com log: no terminal do painel, o `tauri android dev` não achou o SDK.
  - **Emulador:** chega ao PC por `10.0.2.2`. Permissões de câmera e mic: `adb shell pm grant io.github.tyxmatty.jayc.debug android.permission.CAMERA`.
  - **cdp-eval no Android:** `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid do app>` e passe `9223` como porta. A página é `http://tauri.localhost/`.
  - **Screenshot do emulador:** use `adb exec-out screencap -p > arquivo.png` no **Bash**. O PowerShell 5.1 corrompe o binário no redirecionamento.
  - **Vite em dev:** no primeiro uso de um módulo novo, o otimizador de dependências pode recarregar a página e derrubar a chamada. Entre de novo.
- **Testar o app instalado (release)** sem mexer no de dev: rode `%LOCALAPPDATA%\Jay-C\jay-c.exe` com `WEBVIEW2_USER_DATA_FOLDER` apontando para uma pasta de teste e `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9224`. O release e o dev têm o mesmo identificador e dividiriam o perfil do WebView2. Em release não existe `window.__jaycCall`: dirija pelo DOM.
- **Screenshot de uma janela:** use `PrintWindow` (flag 2) no HWND do app. O `CopyFromScreen` pega o que estiver na frente, e pegou um app pessoal do usuário.
- **Medir o áudio recebido no bot:** a página do bot precisa de um clique real (user activation), e a faixa remota precisa estar num `<audio>` mudo tocando. Sem isso, o Chrome entrega silêncio ao WebAudio, e o `totalAudioEnergy` fica 0 para qualquer participante. Isso parece um bug do app, mas não é.
- **Diagnóstico de áudio:** `cargo run --example output_meter` (nível do que sai no alto-falante) e `--example mic_open` (abre o microfone com WASAPI puro e mostra o nível; zeros = mic mudo ou bloqueado), dentro de `plugins/tauri-plugin-system-audio`. `node scripts/make-tone.mjs` gera um tom estéreo de teste.

## Fatos técnicos que custaram para descobrir

- **Microfone no Windows é nativo** (WASAPI + AudioProcessing do WebRTC no plugin), não `getUserMedia`. O mic do WebView2 coloca alguns notebooks (Acer PurifiedVoice / Intel SST) em "modo chamada" e abafa os outros apps em ~65 dB. Ver docs/spikes/09.
- **"Tudo menos o Jay-C" no loopback por processo** exclui a árvore do `msedgewebview2.exe` filho do app, não a do `jay-c.exe`: para o Windows, a árvore do app não inclui o WebView2. Ver docs/spikes/06.
- **Janela escolhida no `getDisplayMedia`:** o rótulo da faixa é `window:<HWND>:0`.
- **Simulcast:** o Chrome só gera as camadas altas se a entrada for grande. Teste com câmera falsa ≥ 1280×720.
- **CSS:** existe a regra global `[hidden] { display: none !important }`, porque componentes com `display` próprio ignoravam `hidden`.
- **AudioWorklet:** o Vite não pode embutir o worklet como `data:` URL, porque a CSP bloqueia (ver `vite.config.js`).
- **AEC3:** para testar, use sinal de banda larga. Tons puros mostram remoção fraca, e o AGC precisa ficar desligado na comparação.
- **Loopback INCLUDE pega a árvore inteira de um processo.** No modo "tela inteira com exclusões", nenhum ancestral do Jay-C ou de um app excluído pode ser raiz, senão o excluído vaza junto (o `explorer.exe` contém quase tudo). Nos testes, players iniciados como filhos do processo de teste contam como "o próprio Jay-C": use `cmd /c start`.
- **PiP no WebView2:** `video.requestPictureInPicture()` funciona e a janela fica sempre no topo. O **Document PiP não funciona**: a API existe, mas falha com "no window". Os controles do PiP vêm da Media Session.
- **Nomes dos alto-falantes (`enumerateDevices`)** só aparecem depois de uma permissão de microfone. No app, o WebView2 concede sem perguntar e lembra no perfil. Sem ela, a lista traz um item sem nome nem id.
- **Animações dependem de `<html data-motion="full">`**, não da media query: Settings › Appearance › Animations tem só Ligado (padrão) e Desligado, e não segue o "reduzir movimento" do Windows (escolha do usuário; uma preferência antiga "system" vale como Ligado). Para testar sem animações, use Desligado.
- **O som remoto toca pelo WebAudio** (`core/playback.js`: um `GainNode` por voz e por live, para passar de 100%). Os `<video>` dos cards ficam sempre mudos, mas precisam continuar tocando: sem um elemento tocando a faixa, o Chrome entrega silêncio ao WebAudio.
- **Faixas remotas chegam `muted`** e só desmutam com os primeiros quadros, sem evento de participante. Uma interface que depende de "tem vídeo?" precisa ouvir `mute`/`unmute` da faixa.
- **Estilos (Calmo, Neon, Suave)** são só tokens: `<html data-style>` troca os blocos de `styles/theme.css` (cada estilo redefine todas as cores no escuro). Componentes usam `--radius-control`, `--radius-call`, `--radius-tile`, `--glow`, `--danger-fill` e `--speaking`, nunca cores fixas. `test/theme-contrast.test.js` lê o `theme.css` e mede o contraste dos 6 combos: mudou uma cor, rode `npm test`.
- **Cor escolhida pelo usuário como texto** (o hífen da marca, as iniciais) usa `--accent-text`, misturada com a cor de texto do tema. Medido: ≥ 5,4:1 nos dois temas.
- **PiP no Android = a activity inteira** (a WebView não tem PiP de `<video>`). Em PiP, o Android pausa a activity e o wry pausa a WebView junto: a mini-janela congela e a página fica `hidden`. O plugin `pip` chama `webView.onResume()` enquanto está em PiP. O evento `pipModeChanged` só chega no fim da animação do sistema (~4,5 s no emulador).
- **Evento `close` do `<dialog>`** só chega no próximo quadro desenhado. Com o painel do navegador escondido, ele nunca chegou. Não guarde estado importante só nele: o tour "Welcome!" grava `welcomeSeen` ao abrir.
- **Tour "Welcome!"** (`core/welcome.js` + `ui/welcome-modal.js`): para testar a primeira abertura, apague `welcomeSeen` (ou a chave `jayc.settings` num perfil de teste) e recarregue. Settings › Help reabre o tour.
- **Ícone da janela segue o estilo** (`ui/window-icon.js`): o `setIcon` do Tauri só põe o ícone pequeno (`ICON_SMALL`, barra de título); a barra de tarefas usa o grande (`ICON_BIG`), que vem do comando Rust `set_taskbar_icon` (`src-tauri/src/taskbar_icon.rs`). `Image.new` não aceita o `Uint8ClampedArray` do canvas (vira objeto no JSON): passe o `.buffer`. Para medir: `WM_GETICON` no HWND do app.
- **Live nativa (Windows):** em "Tela inteira" com um monitor só, a live não usa o `getDisplayMedia`. O Rust (`src-tauri/src/native_live`) captura com WGC, codifica H.264 na GPU (MFT do Media Foundation) e envia por WebRTC (str0m) num transporte próprio; o `core/native-live.js` faz a sinalização. Não há faixa local: o `screenStream` fica vazio e o `call.screenStats()` traz os números do Rust. No MFT da NVIDIA, as opções do `ICodecAPI` (GOP, CBR) **precisam vir antes do `SetOutputType`**. A captura só entrega quadros quando a tela muda. Ver docs/spikes/10-live-nativa.md.
  - **Janela de teste que muda na tela:** um formulário WinForms aberto com `Start-Process -WindowStyle Hidden` fica escondido, com área 0×0, mesmo dizendo "visível". Force-o com `SetWindowPos(..., SWP_SHOWWINDOW | SWP_NOACTIVATE)` e confira a área com `GetClientRect`.
  - **Medir quadros/s:** compartilhe a janela de teste pelo seletor. A captura de janela funciona mesmo coberta, mas não minimizada.
  - **O PC do usuário pode estar em uso:** uma janela piscando por cima atrapalha. Use fundo fixo e barras em movimento, e avise antes.
- **Python no Windows grava CRLF** com `write_text`. Use `newline="\n"`, ou o arquivo aparece como modificado.
