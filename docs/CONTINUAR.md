# Continuar o Jay-C em outro PC

**Português** · [English](CONTINUAR.en.md)

Atualizado em 2026-11-03, no commit seguinte a `d8f7f8b`.

## 0. No PC que já tem o projeto (ex.: o notebook)

```powershell
git pull
npm install         # se os testes do servidor falharem com "mediasoup-worker ENOENT": npm rebuild mediasoup
npm test
```

Depois, **reinicie o `npm run server`**. O protocolo mudou (foto de perfil), e um servidor antigo recusa a troca de foto durante a chamada. Em seguida, `npm run dev`. O primeiro build depois do pull recompila o plugin `system-audio`, mas não o WebRTC APM, que já está pronto no `target`.

## 1. Instalar as ferramentas (Windows)

Em PowerShell. Cada `winget` pode pedir aprovação de administrador (UAC).

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install -e --id Rustlang.Rustup
winget install -e --id Python.Python.3.13 --scope user   # ou 3.14, que também serve
```

Depois, **num terminal novo**, para pegar o PATH atualizado:

```powershell
py -m pip install --user meson ninja
```

Por último, ponha a pasta de Scripts do Python no PATH do usuário. Ela segue a versão (`Python313`, `Python314`...) e é mostrada pelo `pip` no aviso "not on PATH". O Python 3.14 também serve.

```powershell
$scripts = py -c "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))"
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$scripts", 'User')
```

Opcionais:

| Ferramenta | Para quê | Como |
|---|---|---|
| Docker Desktop | rodar o servidor em container (`docker compose`) | `winget install -e --id Docker.DockerDesktop` |
| Android Studio + SDK/NDK | só para o Android | ver `docs/ARQUITETURA.md`, seção 9, ou só a linha de comando (abaixo) |

O WebView2 já vem no Windows 11.

Se o PC tiver MSYS2 no PATH, não há problema: o build do áudio ignora o `pkg-config` dele.

## 2. Pegar o código

Clone **fora do OneDrive**. O build do Rust gera vários GB e o OneDrive tentaria sincronizá-los.

```powershell
git clone https://github.com/TyxMatty/Jay-C.git C:\dev\JayC
cd C:\dev\JayC
npm install
```

O npm 12 bloqueia scripts de instalação. O `allowScripts` do `package.json` libera o do mediasoup. Se os testes do servidor falharem com `mediasoup-worker ENOENT`, rode `npm rebuild mediasoup`.

- **Se clonar dentro do OneDrive mesmo:** crie `.cargo\config.toml` na raiz do repositório, que é local e não vai para o git, com:
  ```toml
  [build]
  target-dir = "C:/Users/<você>/.cargo-target/jay-c"
  ```
- **A cópia do OneDrive:** a pasta `Documentos\JayC` do outro PC também aparece aí, sincronizada. Trabalhe só no clone e use o git (`push`/`pull`) para levar mudanças entre os PCs. Editar as duas cópias gera conflito.

## 3. Rodar

```powershell
npm run server     # terminal 1: sinalização (:3000) + SFU (mídia :40000 UDP/TCP)
npm run dev        # terminal 2: abre o app (o 1º build compila o WebRTC APM; leva alguns minutos)
npm test           # testes
```

- **Firewall:** o Windows pode perguntar sobre o Node.js. Permita, porque é a porta de mídia.
- **Primeira configuração do app:** em Settings › Server, use `localhost:3000`, ou o IP do PC que roda o servidor.
- **Segundo participante para teste:** abra `http://localhost:5173` no Chrome.
- **Terminal aberto antes de instalar algo** não enxerga o PATH novo (ex.: `cargo` não encontrado). Abra um terminal novo, ou use `scripts\dev-debug.ps1`.
- **Rode os comandos na pasta do projeto**, não na pasta do usuário (`npm error ENOENT ... package.json`).
- **CI no GitHub** (`.github/workflows/ci.yml`, roda a cada push na `main` e em cada pull request):
  - no Ubuntu, `npm ci` e `npm test`;
  - no Windows, `cargo test --lib` do plugin `system-audio` e `cargo test` do app. Antes disso, instala Meson e Ninja para o APM e roda o `vite build`, porque o app embute o `frontend/dist`.
  - Os testes Rust que precisam de tela, Discord ou som ao vivo são `#[ignore]` e não rodam lá.
  - Também constrói a imagem Docker do servidor (`signaling-server/Dockerfile`, contexto na raiz) e confere que ela sobe e responde no `/health`. A imagem não é publicada: o nome no GHCR é uma decisão em aberto.
  - O selo "CI" no topo dos READMEs mostra o resultado da última execução na `main`.
- **Instalador no GitHub** (`.github/workflows/installer.yml`): numa tag `v*` ou à mão pela aba Actions ("Installer › Run workflow"), roda o `npm run build` numa máquina Windows limpa. O `Jay-C_<versão>_x64-setup.exe` fica como artefato da execução. A release continua manual: notas, teste do instalador num PC de teste e upload.

## 4. Claude Code no PC novo

Abra a pasta do clone no Claude, no app desktop (aba Code) ou na CLI. O `CLAUDE.md` é carregado automaticamente e traz as regras de trabalho e as armadilhas de build e de áudio. **Desde 05/11/2026 ele não vai para o git** (está no `.gitignore`): copie-o deste PC para a raiz do clone. As notas de "memória" do Claude ficam neste PC; o que importa delas está no CLAUDE.md. Para retomar, diga algo como: *"Leia CLAUDE.md e docs/CONTINUAR.md e siga para a etapa 14 (release)."*

## 5. Estado atual

**Etapas 0 a 13 prontas, e a 14.A (instalador Windows)** (detalhes em `docs/ARQUITETURA.md`, seção 10).

| Etapa | O que entrega |
|---|---|
| Servidor | sinalização + SFU mediasoup em Docker, salas de até 16, porta única de mídia, IP anunciado automático |
| Chamadas | câmera com simulcast de 3 camadas, layouts solo / 1:1 / grade, reconexão |
| Transmissão de tela ou janela | painel de qualidade ao vivo (resolução, fps, texto/movimento) e layout de apresentação para quem assiste |
| Som da transmissão (Windows) | captura nativa por processo. Janela = só o app; tela inteira = tudo menos o Jay-C e os apps excluídos em Settings › Streaming (aplicado ao vivo, apps reavaliados a cada 2 s). Opus estéreo 128 kbps. |
| Guia de setup | modal "Server setup guide" (lobby e Settings › Server) com duas abas: **Connecting** (só conectar: endereço, sala, o que fazer se não conectar) e **Hosting** (os 5 passos, portas, firewall, VPN e a conta de banda de upload; Markdown próprio e 5 imagens) |
| PiP (desktop) | o vídeo em destaque (tela compartilhada ou câmera) flutua sobre as outras janelas, troca sozinho e tem botões de mic, câmera e desligar |
| Microfone nativo (Windows) | WASAPI + AudioProcessing do WebRTC (eco/ruído/ganho) para não abafar os outros apps, com opções em Settings › Microphone aplicadas ao vivo |
| Android | APK de debug com câmera e microfone; entra na chamada e, ao sair do app, vira uma mini-janela (PiP) com o vídeo em destaque. Testado no emulador. |
| Customização | Settings › Appearance: estilo (Calmo, Neon ou Suave, cada um no claro e no escuro), cor dos botões e fundo em degradê (barra do topo translúcida). Fonte Inter embutida. Barra da chamada arrastável em qualquer borda, com ordem livre (também por teclado em Settings › Call controls). Foto de perfil que aparece quando a câmera está desligada, com zoom e corte ao escolher. |

Detalhes da customização em ARQUITETURA.md, seção 10, "Customização". **Plugins ficaram para depois do release**: plugins sem isolamento no cliente estão descartados, porque alcançariam o IPC do Tauri (captura de áudio, tela e microfone).

**Integração com o Jay-A** (o app de áudio da linha Jay, em outro repositório): o plano está em `docs/JAY-A.md`. As etapas I1 a I4 estão prontas: o cliente do pipe, o seletor, o Jay-A falso, o probe, o modo Jay-A no microfone nativo, a interface (Settings › Áudio › Filtro do microfone, avisos, Abrir Jay-A, "não instalado") e o início automático do Jay-A instalado. O app troca para o filtro do Jay-C sem buraco quando o Jay-A cai. A próxima etapa é a I5, o teste com o Jay-A de verdade. Ela espera a etapa 3 do Jay-A (o servidor do Jay Link).

**Próxima: o retorno do teste externo** (lista abaixo, em "Primeiro teste externo"), começando por um novo teste com os amigos usando o diagnóstico. Depois, 14.B (APK de release assinado). As partes da etapa 14 estão em ARQUITETURA.md, seção 10, "Release".

O iOS (etapa 15, só o código) ficou para depois do lançamento.

**Tour "Welcome!" (04/11/2026):** W1 e W2 prontas: 7 cards com uma ilustração animada cada, transição entre os cards e altura fixa; abre na primeira vez e reabre por Settings › Help. Plano e detalhes em ARQUITETURA.md, seção 10, "Tour Welcome!".

**Testes de áudio ao vivo** (tocam som no alto-falante), em `plugins/tauri-plugin-system-audio`:
`cargo test --lib -- --ignored --nocapture --test-threads 1 exclusion_live` e `cargo test --release --lib -- --ignored --nocapture cpu_many_streams`.

**Instalador 0.2.3 (04/11/2026):** a 0.2.2 mais o tour Welcome com as ilustrações animadas (W2). É a versão para mandar aos amigos. O servidor não mudou desde a 0.2.1.

**Instalador 0.2.4 (05/11/2026):** visual novo (Inter, estilos Calmo/Neon/Suave, chamada, lobby, chat com foto, Configurações em cartões), medidor do mic fora da chamada, tela cheia e PiP nas lives, editor de foto e tela cheia no Android (não testada num aparelho). O instalador ganhou o visual Suave: imagem lateral e do topo (`scripts/installer-art.mjs`) e fundo quente. Ícone provisório com a marca do Jay-C no degradê Suave (`frontend/src-tauri/app-icon.svg`), no app, no instalador e no Android, até o Jay-C ter o próprio (etapa 14.D).

**Instalador 0.2.5 (05/11/2026):** a 0.2.4 com a inicial do avatar dentro do círculo em cards grandes.

**Instalador 0.2.6 (05/11/2026):** a 0.2.5 com o ícone da janela e da barra de tarefas no estilo e na cor escolhidos.

**Ícone do Jay-C (05/11/2026, etapa 14.D):** o lobo desenhado pelo usuário substitui a marca provisória.
- **Onde:** no `.exe`, no instalador (ícone e imagens), no Android, na janela, na barra de tarefas e na marca do topo e do lobby.
- **Por que não o traço original:** ele some em 16–32 px. Então o ícone é a "cabeça preenchida": traço engrossado e o interior escuro.
- **Cores:**
  - `.exe`, instalador e Android: laranja Suave sobre a cabeça `#16131B`.
  - Janela e barra de tarefas: as cores escuras do estilo (os desenhos do usuário).
  - Dentro do app: as cores do tema.
- **Como regenerar:** `scripts/wolf-icon.ps1` e depois `tauri icon` (ver CLAUDE.md, "Ícone").
- Publicado no instalador 0.3.1.

**Instalador 0.4.1 (06/11/2026):** a 0.4.0 com o que está abaixo, gerado pelo workflow do instalador no GitHub (tag `v0.4.1`). O servidor não mudou por dentro: um servidor 0.4.0 funciona igual. Só a imagem Docker trocou de base.

**Entre a 0.4.0 e a 0.4.1 (06/11/2026):**
- **Integração com o Jay-A** (etapas I1–I4 do `docs/JAY-A.md`):
  - Settings › Áudio › **Filtro do microfone**: Jay-C (padrão) ou Jay-A;
  - com o Jay-A, o filtro do Jay-C roda junto como reserva e assume sem buraco se o Jay-A cair;
  - avisos na chamada só para quedas de mais de 2 s;
  - **Abrir Jay-A** e "não instalado" com **Baixar o Jay-A**;
  - o Jay-A instalado é iniciado uma vez por chamada.
  - Só faz efeito com um Jay-A que tenha o servidor do Jay Link.
- **Áudio do microfone e da live:** o worklet não corta mais seco depois de uma travada da página. A rajada de blocos vira reserva e sai com crossfade (`docs/spikes/11-continuidade-do-mic.md`).
- **GitHub:** o README da página inicial está em inglês (o português em `README.pt-BR.md`); os links usam o nome novo, `TyxMatty/Jay-C`, inclusive o guia de servidor no app; entraram o CI e o workflow do instalador.
- **Imagem Docker do servidor:** a base passou de `node:24-bookworm-slim` para `node:24-trixie-slim`. Num host com kernel 7, o worker pronto do mediasoup exige glibc 2.38, e o bookworm tem a 2.36: a imagem não construía.

**Instalador 0.4.0 (06/11/2026):** a 0.3.9 com o que está abaixo. O servidor não mudou.

**Entre a 0.3.9 e a 0.4.0 (06/11/2026):**
- **Cards pequenos (debaixo de uma live):** a foto ou a inicial fica no centro do card (antes subia, porque a área dela deixava de fora os 30 px do nome), e o nome tem `z-index` próprio para ficar por cima onde os dois se encontram. Medido em três tamanhos de janela: círculo de 49 px no centro exato de cards de 160×90; no ponto de encontro, o elemento de cima é o nome. A imagem da chamada no README foi refeita.

**Instalador 0.3.9 (06/11/2026):** a 0.3.8 com o que está abaixo. O servidor mudou só por dentro (o aviso de banda); o protocolo é o mesmo, e um servidor 0.3.8 funciona igual.

**Entre a 0.3.8 e a 0.3.9 (06/11/2026):**
- **Versão no app:** "Jay-C <versão>" no canto inferior esquerdo do lobby (escondida em janelas com menos de 900 px, onde cobria o card) e numa seção "Sobre" em Configurações › Ajuda. O número vem do `package.json` do frontend (`define` do Vite), então acompanha cada release.
- **README com imagens** (PT e EN): uma chamada com uma live em destaque, quatro pontos sobre o app e o lobby nos três estilos (`docs/images/`). Capturas só da janela do app de dev (`PrintWindow`, sem a borda invisível do Windows), com perfil de teste e participantes de mentira.
- **Revisão de segurança** (autorização, segredos, uploads): nenhum vazamento de dados nem segredo no código ou nos 123 commits do histórico. Teste novo: ids de outra pessoa ou de outra sala são recusados e nada passa entre salas (verificado por mutação). O exemplo de endereço do tour, que era o IP real do servidor do usuário na Radmin, virou `192.168.0.10:3000`; o IP segue nos commits antigos.
- **Revisão de código (0.3.6 → 0.3.8), itens corrigidos, cada um conferido por mutação** (quebrar a regra de propósito deixa um teste vermelho):
  - `reportViewerBandwidth`: consulta a banda de cada pessoa uma vez por rodada, todas ao mesmo tempo, e não empilha rodadas se o processo de mídia travar; teste de unidade com um roteador falso (`signaling-server/test/sfu-room.test.js`), porque o mediasoup só estima com quem assiste conectado;
  - ensurdecer: o teste agora passa pelo `setTargetAtTime`, o caminho do app (o `else` só para o teste saiu);
  - sons de aviso: a regra (ligados nas Configurações; ensurdecido, só os das nossas ações) virou `cueAllowed` em `core/sounds.js`, com teste;
  - barra de tarefas: `descendants` só conta um processo filho que começou depois do pai (o Windows reusa ids, e um processo cujo pai morreu há tempo pode apontar para um id nosso); teste com dados e outro com um processo filho de verdade.

**Instalador 0.3.8 (06/11/2026):** a 0.3.7 com o que está abaixo. O servidor mudou (`viewer-bandwidth` e a estimativa inicial de 6 Mbps); com um servidor antigo a live funciona como antes, sem o limite.

**Entre a 0.3.7 e a 0.3.8 (06/11/2026):**
- **Live nativa travando para quem assiste acima de 720p** (relato: "travadas extremamente recorrentes", vídeo e anime, os dois lados, servidor no PC do usuário). A live nativa tem uma camada só, e quem transmite só enxergava o próprio trecho até o servidor: com o servidor no mesmo PC, a estimativa era de ~12 Mbps e a live saía em 1080p60 a ~7 Mbps para todos. Medido com uma janela de 1920×1080 em muito movimento, quem transmite no app de dev, quem assiste num Chrome sem janela e um gargalo de UDP de 4 Mbps (fila de 200 ms) só para quem assiste: **0 quadros/s durante 30 s** (~600 pacotes perdidos/s, pedidos de quadro-chave sem parar) enquanto quem transmite seguia em 7,7 Mbps. Agora:
  - o servidor manda a cada 2 s, para quem transmite, a menor banda entre quem assiste (`viewer-bandwidth`, do `availableOutgoingBitrate` do mediasoup), e o Rust limita a live a 70% dela (`native_live_viewer_kbps`), descendo a escada (1080p60 → 720p30…);
  - a estimativa para cada pessoa começa em 6 Mbps (era 1 Mbps): com o limite, 1 Mbps prenderia uma tela parada em 540p, porque ela não cresce sem tráfego;
  - cada descida da escada dobra a espera para subir de novo (3 s → 6 → 12, até 30 s): com 85% e 3 s, a live subia a 1080p60 de novo e o quadro-chave inundava a conexão (2 a 7 s sem imagem).
  - Medido, 4 Mbps: imagem firme aos 8 s, depois 55 s em 720p30 sem perdas e sem travar (pausas < 0,2 s). Conexão boa: 1080p60 a 55 quadros/s e ~7 Mbps por 60 s, sem perdas, como antes.
  - **Limites:** os primeiros ~8 s de quem assiste numa conexão lenta ainda engasgam (a live sai em 1080p60 até o servidor perceber); quem assiste mais devagar puxa a live de todos para baixo; e o gargalo foi simulado, não medido numa internet de verdade.
- **Medido também, sem mudança:** a renovação do áudio atrasado (0.3.7) não trava o vídeo (4 renovações forçadas a cada 15 s: nenhuma pausa acima de 200 ms, atraso do vídeo igual). A captura e o codificador seguram 1080p60 em muito movimento neste PC (56–58 quadros/s).

**Instalador 0.3.7 (05/11/2026):** a 0.3.6 com o que está abaixo. O servidor mudou (`closeConsumer`); um servidor antigo continua funcionando.

**Entre a 0.3.6 e a 0.3.7 (05/11/2026):**
- **Ensurdecer (deafen):** botão de fone ao lado do microfone. Silencia tudo o que chega (o mixer ganhou um canal das vozes e lives, zerado com uma rampa de ~15 ms) e desliga o microfone; desensurdecer volta o microfone como estava; ligar o microfone ensurdecido desensurdece (como no Discord). Quem já tinha uma ordem salva para a barra recebe o botão ao lado do microfone (`normalizeOrder` põe um botão novo ao lado do vizinho). Medido no app de dev pela captura só do próprio WebView2: ensurdecido -120 dB, desensurdecido -13 dB (o tom de 440 Hz de um bot), de volta a -120. Os outros não veem o fone, só o microfone desligado.
- **PiP numa janela própria (Windows):** o PiP do WebView2 mostrava a origem da página ("tauri.localhost") e só os botões da Media Session. Agora o `window.open('')` da página vira uma janela do Jay-C (`src-tauri/src/pip_window.rs`): sempre no topo, sem barra de título, 480×270 no canto inferior direito, redimensionável (mín. 200×112), arrastável por qualquer ponto fora dos botões (`pip_drag`). A página preenche a janela (mesmo processo, então a mesma `MediaStream` toca lá) com o vídeo e os botões de microfone, câmera, sair e fechar, que aparecem ao passar o mouse. Só `about:blank` abre; qualquer outra URL é recusada. Para isso a janela principal é criada no `setup` (com `on_new_window`), e o `tauri.windows.conf.json` desliga a criação automática só no Windows. O WebView2 às vezes troca a página da janela depois de preenchida (janela branca, vista pelo usuário): a página confere a cada 300 ms e preenche de novo. Medido no app de dev: janela 480×270 no topo, no grupo do Jay-C na barra de tarefas, vídeo 1280×720 tocando, botões funcionando, e o preenchimento de novo depois de trocar a página à força. O `window.close()` da página fechava só a página e deixava a janela nativa branca e sem botões (o X do PiP e o fim da live, vistos pelo usuário): a janela é fechada pelo Rust (`pip_close`), e também quando a janela principal fecha (senão o app seguia aberto) ou a página recarrega. Medido: depois do X e do fim da live, só a janela `main` existe; fechando o Jay-C com o PiP aberto, o processo termina. **Não testado:** arrastar e redimensionar com o mouse.
- **PiP na mesma pilha do Jay-C:** com o ID próprio da janela (0.3.5), a janela do PiP (do WebView2, um processo filho) aparecia como outro app ("Microsoft Edge WebView2"). Ao abrir o PiP, o app dá às janelas dos processos filhos o mesmo ID e ícone (`group_child_windows`). Medido: o PiP do app de dev entrou no grupo do Jay-C; o do app instalado (0.3.6, sem a mudança) seguiu separado.

- **Sons de aviso** (`core/sounds.js`): sintetizados no WebAudio, sem arquivos, num canal de alertas do mixer (vai direto ao alto-falante escolhido, fora do canal das vozes, ~-16 dBFS por cue). Subindo = ligou/entrou, descendo = desligou/saiu: microfone, ensurdecer (mais grave), alguém entrou, saiu, começou uma live, mensagem com o chat fechado (um bip), e a nossa entrada na sala. Variação de ±2% no tom. Ensurdecido, só tocam os das nossas ações. Configurações › Áudio › "Tocar sons de aviso" (ligado). Medido no app de dev, registrando cada nota tocada: cada evento tocou a sua sequência, e o chat do bot com o app ensurdecido não tocou nada.

- **Áudio que ficava atrasado depois de uma travada** (`core/catch-up.js`): medido com uma janela-relógio transmitida e o processo de mídia do servidor congelado por 3 s, o vídeo descarta os quadros velhos e volta na hora, mas o áudio guardava 2,5 s e só drenava 0,2 s por segundo (~17 s fora de sincronia; numa travada maior, muito mais). Agora o app confere o buffer de cada áudio recebido a cada 1 s (`getStats`) e, acima de 500 ms em duas conferências seguidas, abre um consumer novo (pedido novo `closeConsumer` no servidor; um servidor antigo recebe `pauseConsumer`). Medido: de volta a 30 ms ~3 s depois da travada. Também pegou um atraso de 1,4 s logo ao começar a assistir. A sincronia fina entre áudio e vídeo de uma live não foi resolvida: agrupar as faixas por `streamId` no mediasoup-client foi testado numa live nativa (janela-relógio com um clique por segundo) e não mudou nada (vídeo ~46 ms, áudio 147–198 ms de atraso, antes e depois), então foi desfeito. A live nativa manda vídeo e áudio por transportes diferentes.

**Instalador 0.3.6 (05/11/2026):** só a correção dos nomes das imagens do Discord: o Calmo e o Neon usam `discord-wolf-calm` e `discord-wolf-neon`, como ficaram na aplicação (a 0.3.5 procurava nomes que não existem e mostrava esses estilos sem imagem). O servidor não mudou.

**Instalador 0.3.5 (05/11/2026):** a 0.3.4 com o que está abaixo. O servidor não mudou.

**Entre a 0.3.4 e a 0.3.5 (05/11/2026):**
- **A própria live no card de quem transmite**, com a qualidade e os quadros/s de verdade: o Rust entrega os quadros H.264 à página e o WebCodecs decodifica na GPU. ~0,2 núcleo a mais enquanto o card aparece; pausa com o app minimizado. Ver docs/spikes/10-live-nativa.md, "A própria live no card".
- **Janela compartilhada minimizada** não encerra mais a live (o último quadro segue saindo).
- **Compartilhar de novo depois de uma live que acabou sozinha** (janela fechada) não cai mais no seletor do sistema.
- **Discord:** os lobos grossos em todos os estilos (`discord-wolf-calm`, `discord-wolf-neon`, `jayc_orange_thick`).
- **Ícone da barra de tarefas no app instalado:** seguia o laranja do `.exe` em qualquer estilo, porque o Windows liga o `jay-c.exe` ao atalho do Menu Iniciar e usa o ícone dele.
  - A janela agora tem um AppUserModelID próprio (`io.github.tyxmatty.jayc.window`) e propriedades de "relaunch" com um `.ico` do estilo, gravado em `%LOCALAPPDATA%\io.github.tyxmatty.jayc\taskbar-*.ico` (`src-tauri/src/taskbar_icon.rs`).
  - Medido com um atalho temporário apontando para o app de dev (o mesmo laço do instalado): roxo no Calmo, ciano ao trocar para Neon, roxo de novo, sempre com o nome "Jay-C".
  - O instalador agora pede ao Windows para atualizar o cache de ícones no fim (`SHChangeNotify`), contra o ícone antigo no menu do botão direito. Não testado: só roda num build de instalador, e o instalador não roda neste PC.
  - Um app fixado na barra mostra o ícone de quando foi fixado (o Windows usa o do atalho fixado).

**Instalador 0.3.4 (05/11/2026):** a 0.3.3 com o que está abaixo e o Discord Rich Presence: durante uma chamada, o perfil do Discord mostra o Jay-C (pessoas, tempo, live sem nomes, o lobo do estilo), com as opções em Settings › Perfil › Discord. Plano e medições em ARQUITETURA.md, seção 10, "Discord Rich Presence". O servidor mudou (a mensagem `screen-preview`); um servidor antigo continua funcionando, sem as prévias.

**Entre a 0.3.3 e a 0.3.4 (05/11/2026):**
- **Sem seleção de texto:** arrastar com o botão esquerdo não seleciona mais rótulos, botões e imagens (`user-select: none` no `body`). Campos de texto, mensagens do chat e o guia de setup continuam selecionáveis. Medido com arraste real (CDP): nada selecionado; com a seleção forçada de volta, o mesmo arraste pega o texto do lobby.
- **O Jay-C na live:**
  - A live nativa não esconde mais a janela do Jay-C (afinidade 0 durante a live da tela inteira).
  - O seletor lista a janela do próprio Jay-C (`own`), transmitida sem som: o som dela é o da chamada e voltaria para todos.
  - Só a live pelo seletor do sistema, que tem prévia local, ainda esconde o Jay-C (efeito espelho).
- **Prévia da live:**
  - Quem transmite manda uma imagem (JPEG de 320 px, ~10 KB) a cada 6 s, pela mensagem nova `screen-preview`. O "Assistir live" vira um card com a imagem.
  - O próprio card da live, que era "Ao vivo · sem prévia", mostra a imagem, atualizada a cada 2 s.
  - Na live nativa, a imagem sai do último quadro da live, reduzido na GPU (mipmaps): ~10 ms e ~15 ms de CPU no build de dev, contra 230 ms e 166 ms com uma captura nova (a miniatura do seletor).
  - Servidor antigo: o app não manda as imagens (o `joined` não lista `features`).

**Instalador 0.3.3 (05/11/2026):** a 0.3.2 com as correções da revisão de código (live nativa com a tela parada, quedas de rede, transporte fechado ao parar, parar durante o início, erros do codificador; entrar na sala sem chamada fantasma) e o microfone que volta sozinho ao reconectar. Ver "Correções depois da revisão de código", abaixo.

O servidor mudou: o pedido novo `closeTransport`. Um servidor antigo continua funcionando com o app novo.

**Instalador 0.3.2 (05/11/2026):** a 0.3.1 com:
- o lobo maior nos ícones (recortado no desenho: 98% do quadrado na janela e na barra de tarefas, 94% no `.exe`);
- o lado esquerdo do lobby na altura do cartão, com o lobo grande no traço fino original crescendo para preencher;
- Animações só com Ligado (padrão) e Desligado, sem seguir o Windows.

O servidor não mudou.

**Instalador 0.3.1 (05/11/2026):** a 0.3.0 com o ícone do Jay-C (o lobo) no `.exe`, no instalador, na janela, na barra de tarefas e na marca do app. O servidor não mudou.

**Instalador 0.3.0 (05/11/2026):**
- **Live nativa no Windows:** captura, H.264 na placa de vídeo e WebRTC próprio, em ~0,3 núcleo contra ~1,5, com resolução e quadros/s que se adaptam à banda. Vem com o seletor próprio de telas e janelas, com miniaturas, e sem prévia da própria live.
- **App sem menu nem atalhos de navegador.**
- **Calmo em violeta:** `#AA8BFF` no escuro.
- **Servidor:** não mudou; a live nativa usa o mesmo `createTransport`/`produce` e a porta 40000.
- **Ainda não testado:** a live nativa com quem assiste em outro PC, e placas Intel/AMD. Se o nativo falhar ao começar, a live usa o seletor do Chromium.

**Instalador 0.2.2 (04/11/2026):** idioma do app (Settings › Aparência › Idioma: Sistema, English ou Português (Brasil); o padrão segue o Windows) com tudo em PT-BR informal, inclusive o guia do servidor e o tour Welcome. Textos em inglês no código, passados por `t()` (`core/i18n.js`), com as traduções em `src/locales/pt-BR.js`; um teste confere que todo `t('…')` tem tradução. O guia tem a pastilha **Copiar** em cada comando. O instalador pergunta o idioma ao abrir (English / Português) e usa `frontend/src-tauri/windows/PortugueseBR.nsh` para os textos do Tauri.

**Perda de configurações no teste do instalador (04/11/2026):** a pasta `%LOCALAPPDATA%\io.github.tyxmatty.jayc` (perfil do WebView2 do app de dev e do instalado) foi recriada vazia às 11:50, durante o teste da 0.2.1, e as configurações do usuário foram restauradas à mão. Repetindo a sequência com um arquivo-marcador (instalar 0.2.0 em silêncio, 0.2.1 por cima com interface, desinstalar em silêncio), nada foi apagado: a causa não foi achada. Antes de testar instaladores, copie essa pasta.

**Instalador 0.2.1 (04/11/2026):** a 0.2.0 mais a live de tela inteira sem efeito espelho, o H.264 High pela placa de vídeo (com VP8 de reserva), o limite do chat e o guia com `npm run server`. O servidor também está em 0.2.1: o host precisa reiniciá-lo (perfil H.264 novo e limite do chat). É essa versão que os amigos devem instalar. **Quem já tem uma versão mais velha só roda o instalador:** ele atualiza por cima, sem a página "Desinstalar antes de instalar" (template NSIS próprio, ver CLAUDE.md). Medido: 0.2.0 instalada → instalador 0.2.1 com interface: boas-vindas, instalando, concluído; o registro foi para 0.2.1 e o executável foi trocado. A mesma versão ou um downgrade continuam perguntando.

**Instalador 0.2.0 (04/11/2026):** traz o retorno do teste externo (itens 1–8) e a revisão de design (A–E). Para o próximo teste, os amigos instalam a 0.2.0, o host reinicia o servidor (o protocolo mudou: `pauseConsumer`, `chat`, `color`), e quem não ouvir manda o texto de Settings › Help › Copy call diagnostics.

**Instalador Windows:** `npm run build` gera `<target>\release\bundle\nsis\Jay-C_<versão>_x64-setup.exe`. Leva ~7–9 min, por causa do LTO.

**Primeiro teste externo:** em 03/11/2026, o instalador 0.1.0 foi enviado a amigos do usuário. O servidor é hospedado pelo usuário, e eles se conectam pelo IP dele (VPN ou LAN), com as portas 3000 e 40000 liberadas. Sem assinatura de código, o SmartScreen pede "Mais informações → Executar assim mesmo". Amigos no Radmin VPN: o host é o IP do usuário na Radmin (`26.x.x.x`).

**Retorno do teste externo (04/11/2026), na ordem combinada:**
1. **Bug: quem entra numa sala com gente dentro não ouve os outros, mas é ouvido.** Valia para qualquer um que entrasse depois. A pessoa via o vídeo dos outros (a rede chega), e sair e entrar de novo resolvia para ela. **Não reproduzido neste PC**, com o som medido no alto-falante (`output_meter`) em 5 cenários: dev, release com clique real e perfil limpo, primeira entrada depois de abrir o app, bot com câmera e bot saindo e voltando. Também não reproduziu pelo IP do Radmin. Para o próximo teste foi criado **Settings › Troubleshooting › Copy call diagnostics**: mede por 2 s, para cada pessoa, pacotes/s, kbps e `playedEnergy`, além do estado do player. Quem não ouvir copia o texto e manda. Pacotes chegando com `playedEnergy` 0 = o som chega mas não toca; sem pacotes = rede ou servidor.
2. Live trava com o app em foco e fica lisa no Alt+Tab. **Medido neste PC** (tela inteira real, com o seletor escolhido pela flag `--auto-select-desktop-capture-source="Tela inteira"`):
   - **Efeito espelho confirmado:** com o Jay-C em foco, ele filmava a própria prévia. A live mandava 450–600 kbps, contra 180–200 com outra janela em foco. Com a janela fora da captura, mandou 20–25% menos com o Jay-C em foco, e o FPS de captura ficou igual. ✅ Corrigido: durante a live de tela inteira, o Jay-C some da captura (`setContentProtected`, `WDA_EXCLUDEFROMCAPTURE`). Efeito colateral: nesse tempo, prints e gravações (Win+Shift+S, OBS) também não mostram a janela do Jay-C, e um aviso diz isso ao começar a live.
   - **Encoder:** a live usava VP8 em software (libvpx, 7–20 ms por quadro em 720p). ✅ Agora usa H.264 High, que o WebView2 manda para a placa de vídeo. Só quando o WebView consegue enviar High (`RTCRtpSender.getCapabilities`) e o servidor tem o perfil; se o `produce` falhar mesmo assim, a live recomeça no codec padrão (VP8). Medido: com o High escondido do WebView, a live saiu em libvpx. Constrained baseline ficava no OpenH264 em software. Verificado: um bot decodifica pelo servidor (720p, 35 qps). A CPU total **não caiu** neste PC (~0,8 núcleo nos dois casos), porque a captura pesa mais que a codificação; a diferença deve aparecer em CPUs mais fracas, mas isso não foi medido.
   - **Prévia da própria live** visível custou ~0,1–0,4 núcleo (medida ruidosa).
   - **Quem assiste:** sem diferença entre o app em foco e fora dele (43–55 qps, sem congelamentos).
   - **Explicação provável do "liso no Alt+Tab":** com o jogo em tela cheia na frente, o Windows marca o Jay-C como encoberto, e o WebView para de desenhar (prévia, espelho), sobrando máquina para o jogo e a codificação. **Precisa do servidor reiniciado** (perfil H.264 novo) e de um novo teste com os amigos.
3. Atalhos do Windows (tecla Windows, Win+Shift+S) param durante a live. Eles dizem que outros apps de live também causam isso, menos o Discord. **Não reproduzido neste PC:** com uma live real de tela inteira, a tecla Windows (sintética, via `keybd_event`) abriu o Iniciar e Win+Shift+S abriu o recorte, com o Jay-C em foco ou não (3 rodadas). O app não usa atalhos globais, hooks de teclado nem `keyboard.lock`. Próximo passo: perguntar aos amigos se o jogo estava em tela cheia exclusiva e se acontece sem o Jay-C (eles disseram que outros apps causam o mesmo).
4. ✅ Padrões: câmera começa desligada; a live dos outros começa sem som e fora de foco, e cada um escolhe assistir (como no Discord). Feito: o card de quem transmite mostra **LIVE · Watch stream**. Até clicar, a tela e o som da live ficam pausados no servidor (0 kbps, medido), sem layout de apresentação e fora do PiP. **Stop watching** pausa de novo. Uma live nova começa sem ser assistida.
5. Áudio, no menu do botão direito.
   - ✅ **5A:** volume por pessoa e por live (0–200%) e mudo só para si, no clique direito sobre o card (ou tecla Menu com o card em foco), além de um botão **Mute stream** na live assistida. O som remoto passa pelo WebAudio (`core/playback.js`), com um ganho por voz e por live; os `<video>` ficam mudos. Medido no alto-falante: 100% = -13,5 dB, 200% = -7,5 dB, mudo = silêncio. Os níveis valem só durante a chamada.
   - ✅ **5B:** Settings › Audio devices (também pelo clique direito no botão do microfone):
     - **Microfone:** lista nativa (WASAPI, `list_mics` no plugin). Um microfone que sumiu volta ao padrão do Windows.
     - **Volume do microfone** (0–300%) e **"Only send when I speak"** (gate com limite em dB, 300 ms de espera e rampa), com medidor durante a chamada. Ficam em `core/mic-shape.js`, aplicados ao vivo.
     - **Alto-falantes:** `AudioContext.setSinkId` no mixer. Os nomes só aparecem depois de uma permissão de microfone do WebView2, concedida sem pergunta e lembrada. O botão "Show speakers" abre o mic do WebView por ~0,1 s uma única vez.
     - **Medido no app:** gate em -10 dB → envio 0; troca de microfone ao vivo (ME6S → Iriun → padrão); saída na "Saída Digital" → o alto-falante padrão fica em silêncio, e volta a -13,5 dB.
     - **Não provado no app:** o ganho. O ruído ambiente variou demais, e só o teste unitário mede o efeito (+6,02 dB a 2×).
     - **Só no Windows:** microfone, volume e sensibilidade (o mic do Android/macOS ainda é o `getUserMedia`).
6. ✅ Focar numa live entre várias, ou na própria: clicar numa live (ou Enter com ela em foco de teclado) a deixa grande, e as outras vão para uma coluna ao lado. Clicar de novo divide o espaço igualmente. A prévia da sua live, no canto, vai para o palco com um clique e volta com outro. Verificado no app com 2 bots transmitindo e a própria live: tamanhos e vídeos tocando depois de cada troca.
7. ✅ Chat da chamada: botão **Chat** na barra (com contador de não lidas) abre um painel lateral. Mensagens novas com o painel fechado também aparecem num aviso. O servidor só repassa (`chat`, 1–500 caracteres, sem caracteres de controle, no máximo 2 por segundo com rajada de 10 por pessoa) e não guarda nada: quem entra depois não vê o histórico. Verificado no app com um bot: contador, aviso, resposta digitada no teclado chegando ao bot, HTML exibido como texto, Esc fechando o painel. Mensagem recusada (excesso, ou servidor antigo sem chat) mostra um aviso, em vez de parecer enviada.
8. ✅ Botões em destaque: mic, câmera e live com 64 px (os outros têm 52), "bounce" no hover e no clique em todos os botões da barra (desligado com "reduzir movimento" do sistema, que está ligado neste PC), e borda verde (#16a34a) no card de quem fala, inclusive o seu (`core/speaking.js`: -50 dBFS, 400 ms de espera; o nível vem dos analisadores do mixer). Medido no app: a borda acompanha um tom que liga e desliga a cada 1 s; o hover vai a 1,11 e assenta em 1,10, e o clique a 0,90. A sua própria borda não foi vista acender, porque ninguém falou no microfone durante o teste.

**Revisão de design (04/11/2026), inspirada no Discord:**
- ✅ A. Cor de perfil: Settings › General › Profile color (Auto pelo nome, Solid ou Gradient, com prévia). Vai aos outros no `join` e no `profile`, e o servidor só aceita `#rrggbb` e ângulo inteiro. Os cards sem câmera usam a cor de fundo, com o avatar num círculo. Quem não escolheu ganha um degradê estável pelo nome (`core/profile-color.js`). Verificado no app com 2 bots, nos temas escuro e claro: cada card com a sua cor, e a troca chegou aos dois ao vivo.
- ✅ B. Settings com abas laterais: Profile, Appearance (tema, cores, botões da chamada), Audio, Streaming (só onde há captura de som), Server e Help (diagnóstico). Numa janela estreita, as abas viram uma linha no topo. As abas vêm do helper `ui/tabs.js` (padrão ARIA: uma parada de Tab, setas, Home/End), que o guia de setup também usa. O clique direito no mic abre direto na aba Audio. Verificado no app: teclado, atalho do mic, guia, 480 px sem rolagem lateral, temas claro e escuro.
- ✅ C. Lobby com cartão de perfil e salas recentes. No topo do card, o perfil como os outros te veem (faixa na sua cor, avatar e nome), com o botão "Edit profile", que abre a aba Profile. Abaixo do campo Room, as últimas 5 salas (`core/recent-rooms.js`): um clique entra. A mensagem "room-full" deixou de dizer "4 people max" (o padrão é 16 e é configurável). Verificado no app: entrar pelo botão da sala, a sala indo para o início da lista, 360 px, temas claro e escuro.
- ✅ D. Cabeçalho da chamada: "# sala", "Just you" ou "N people" e o botão de copiar, numa pílula com fundo próprio (legível sobre qualquer degradê, nos dois temas). O cartão "Waiting for others" deixou de repetir o nome da sala. Verificado no app: "Just you" → "2 people" com um bot, a cópia mostrando o aviso, nome cortado com "…" e tooltip a 360 px, tema claro.
- ✅ E. Animações (só com o movimento do sistema liberado): diálogos e popovers entram e saem com fade (`@starting-style` + `allow-discrete`); o chat desliza; os avisos sobem; os cards novos "pulam"; a aba do Settings aparece suave; a troca de foco das lives usa View Transitions. Usam `translate`/`scale`/`opacity`, sem mexer nos `transform` de posição. Medido no app com as animações liberadas (diálogo 0,05 → 1; chat 0,28 → 1; menu 0,43 → 1; card novo com `tile-in`; foco com 15 animações de view transition) e com "reduzir movimento" (tudo instantâneo). **Settings › Appearance › Animations: System / On / Off.** System segue o Windows (este PC tem as animações desligadas, então nele só aparecem com On). `core/motion.js` resolve a escolha e o `ui/theme.js` põe `<html data-motion="full|reduced">`, que o CSS usa no lugar da media query. Medido: com o Windows reduzindo movimento, On anima (diálogo 0,4 em 50 ms, bounce 1,11); com o Windows liberando, Off para tudo.

Eles sugeriram reescrever sem o WebView ("engine própria, estilo Discord"). Recomendação dada: não. O Discord também é Chromium (Electron), e o que ele faz diferente é capturar e codificar em código nativo. Se os itens 2 e 3 apontarem para o WebView, a saída é uma etapa de captura de vídeo nativa (WGC/DXGI + H.264 por hardware).

**Live nativa, spike (05/11/2026):** ver [spikes/10-live-nativa.md](spikes/10-live-nativa.md).
- **O que é:** captura (Windows Graphics Capture) e H.264 por hardware (Media Foundation) em Rust, enviados por WebRTC (str0m) ao mesmo `WebRtcTransport` e à mesma porta 40000 do app. O servidor não muda.
- **Medido:**
  - CPU: a live atual gasta ~1,3 núcleo só no vídeo, e a nativa gasta ~0,05.
  - Quem assiste recebe 1080p sem perdas.
  - Numa rede estreita simulada, a resolução e os quadros/s descem em degraus (1080p60 → 720p30 → 540p30 → 360p15) em segundos, com 0–53 pacotes perdidos (antes eram ~500), e voltam sozinhos.
  - O que quem assiste vê na queda não foi medido de forma confiável: o espectador no mesmo PC atrapalha a captura. Falta um teste em dois PCs.
- ✅ **No app:**
  - Em "Tela inteira", com um monitor só, a live é nativa: sem seletor e sem prévia ("Ao vivo · sem prévia"). Se falhar, cai no caminho antigo.
  - Medido: a árvore do app em live gasta 0,68–0,72 núcleo, contra 1,88 da live antiga.
  - Quem assiste recebe 1080p com som, sem perdas. A taxa de quadros no app não foi medida de forma confiável (você estava usando o PC).
- ✅ **Seletor próprio** (Windows):
  - "Escolher e transmitir…" abre a lista de telas e janelas com miniaturas, e a live sai nativa do que for escolhido, em qualquer monitor ou janela.
  - Com uma janela, a live acompanha o redimensionamento e termina se a janela fechar.
  - Medido: com uma janela que muda de verdade, 56–59 quadros/s no envio.
  - **Correção:** as taxas de quadros anteriores foram medidas com a janela de animação escondida (ver o spike 10).

**Correções depois da revisão de código (05/11/2026):**
- **Live nativa:**
  - Envia imagem mesmo com a tela parada (o último quadro a cada 1 s, e na hora para quem começa a assistir).
  - Aguenta quedas de rede de até 20 s e recomeça sozinha quando o servidor volta.
  - Fecha o próprio transporte no servidor ao parar (`closeTransport`: **reinicie o servidor** para ter isso; um servidor antigo continua funcionando).
  - Para de verdade se você sair da chamada enquanto ela começa.
- **Entrar na sala:** se a tela da chamada falhar ao abrir, a chamada é encerrada, em vez de ficar conectada atrás do erro do lobby.
- **Microfone que desconecta e volta:** o app verifica os microfones a cada 3 s e reabre sozinho, sem precisar mexer numa configuração.
  - Se o escolhido sumiu, ele usa o padrão do Windows e volta para o escolhido quando ele reaparece.
  - Medido com o ME6S de verdade: ele caiu (`0x88890004`), o app foi para o novo padrão (Voicemeeter) com o aviso "Microfone de volta", e voltou para o ME6S 1 s depois de ele reaparecer.
  - **Atenção:** o Windows renomeou o ME6S ao reconectar ("8- ME6S" → "3- ME6S"). Se o microfone foi escolhido em Configurações e o id mudar ao trocar de porta USB, o app fica no padrão até ele ser escolhido de novo.

**Sem cara de navegador (05/11/2026):** no release, o clique direito fora dos campos de texto não abre mais o menu do WebView2 (Voltar, Atualizar, Imprimir, Inspecionar), e os atalhos de navegador ficam desligados (`SetAreBrowserAcceleratorKeysEnabled(false)`, em `src-tauri/src/app_chrome.rs`): F5/Ctrl+R não recarregam a página (o que derrubava a chamada), nem Ctrl+P/Ctrl+F abrem impressão e busca. Campos de texto mantêm o menu de copiar/colar. O dev mantém tudo, para depurar.

**Android em dev** (emulador ou celular com depuração USB):
- **Modo de Desenvolvedor do Windows ligado:** o Tauri cria symlinks para a `.so` em `jniLibs`.
- `scripts\android-dev.ps1` recarrega PATH, `JAVA_HOME`, `ANDROID_HOME` e `NDK_HOME` e roda `tauri android dev`. O app carrega o Vite pelo IP do PC na porta 5173.
- **Servidor no emulador:** use `10.0.2.2:3000`, que é o PC visto de dentro do emulador. No celular, use o IP do PC na rede.
- **Permissões:** o app pede câmera e microfone na primeira chamada. Em testes automáticos, conceda antes com `adb shell pm grant io.github.tyxmatty.jayc.debug android.permission.CAMERA` (e `RECORD_AUDIO`).
- **SDK sem o Android Studio** (feito no PC atual, sem UAC): JDK 21 da Microsoft (zip) em `%LOCALAPPDATA%\Programs\MicrosoftJDK`, command-line tools em `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`, e `JAVA_HOME`/`ANDROID_HOME`/`NDK_HOME` nas variáveis do usuário. O `sdkmanager` novo é um atalho do "Android CLI": pelo Bash, os pacotes vão com barra (`platforms/android-37.0`, `ndk/30.0.16248370`), porque o `;` quebra no `.bat`. Instalados: platform-tools, emulator, platforms 37.0, build-tools 37.0.0, NDK 30.0.16248370 e a imagem `android-36/google_apis/x86_64`.
- **Emulador neste PC:** não roda. A virtualização está desligada na BIOS/UEFI (`VirtualizationFirmwareEnabled = False`) e falta a Plataforma do Hipervisor do Windows.
- **Sem o Modo de Desenvolvedor**, o `tauri android build` compila o Rust e para no symlink da `.so`. Para conferir só o Kotlin de um plugin: `gradlew :tauri-plugin-pip:compileDebugKotlin` em `frontend/src-tauri/gen/android`.

**Ainda não verificado:**
- O instalador em outro PC, o seletor de tela real no app instalado e a conexão de amigos pela internet/VPN (aguardando o retorno do teste externo).
- Android num celular real, e o PiP no Android 8–11 (entrada pelo user-leave hint).
- **Tela cheia da live no Android** (barras escondidas, paisagem, voltar sai): o Kotlin compila e a parte da página foi testada simulando Android no PC, mas não rodou num aparelho.
- Sala com 16 pessoas com mídia real (foi testado com 6 abas, e com 16 só no protocolo).
- IP de VPN (ZeroTier/Radmin).
- Som no modo janela com o seletor real (o caminho foi validado por partes).
- Botões de mic, câmera e desligar na janela do PiP: as ações da Media Session foram aceitas, mas os botões só aparecem com o mouse em cima e não foram clicados.
- Exclusões com o Discord de verdade e alguém ouvindo do outro lado. Foram medidas com tons e com a faixa enviada ao WebRTC, usando um canvas falso no lugar do seletor.
- Cancelamento de eco com alto-falante real, porque o microfone do notebook de teste não capta os próprios alto-falantes.
- Customização:
  - arrastar a barra por toque (só no Android);
  - a barra lateral com 2+ pessoas na chamada;
  - foto de perfil com uma foto real do disco (testado com imagens geradas);
  - o fallback JPEG da foto no WebKit (macOS/iOS).
- O link do guia no lobby, que só aparece sem servidor configurado.
- Uma falha possível no som da tela inteira (stream único): duas medições deram 46–47,5 mil quadros/s em vez de 48 mil, sem se repetir depois. Ver ARQUITETURA.md, "CPU".

**Decisões em aberto:**
- Nome da imagem no GHCR (`ghcr.io/tyxmatty/jay-c-signaling`).
- Tamanho da imagem Docker (379 MB).
- Bundle do frontend (~58 KB gzip, a maior parte do mediasoup-client).
- O guia (aba Hosting) oferece duas formas. A **opção A, Node.js** (`npm install -w signaling-server` + `npm run server`), funciona hoje: num clone limpo, a instalação levou 11 s e baixou o `mediasoup-worker.exe` pronto. Ela pede o ZIP do GitHub numa pasta curta, porque o caminho mais longo do repositório tem 152 caracteres e um clone numa pasta funda falhou com "Filename too long". O ZIP só baixa com o repositório **público** (hoje é privado). A **opção B, Docker**, conta com o `docker-compose.yml` na página de releases e a imagem no GHCR, que só existem na etapa 14.
