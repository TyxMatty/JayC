# Continuar o Jay-C em outro PC

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
| Android Studio + SDK/NDK | só para o Android | ver `docs/ARQUITETURA.md`, seção 9 |

O WebView2 já vem no Windows 11.

Se o PC tiver MSYS2 no PATH, não há problema: o build do áudio ignora o `pkg-config` dele.

## 2. Pegar o código

Clone **fora do OneDrive**. O build do Rust gera vários GB e o OneDrive tentaria sincronizá-los.

```powershell
git clone https://github.com/TyxMatty/JayC.git C:\dev\JayC
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

## 4. Claude Code no PC novo

Abra a pasta do clone no Claude, no app desktop (aba Code) ou na CLI. O [CLAUDE.md](../CLAUDE.md) é carregado automaticamente e traz as regras de trabalho e as armadilhas de build e de áudio. As notas de "memória" do Claude ficam neste PC; o que importa delas está no CLAUDE.md. Para retomar, diga algo como: *"Leia CLAUDE.md e docs/CONTINUAR.md e siga para a etapa 14 (release)."*

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
| Customização | Settings › Appearance: cor dos botões e fundo em degradê (barra do topo translúcida). Barra da chamada arrastável em qualquer borda, com ordem livre (também por teclado em Settings › Call controls). Foto de perfil que aparece quando a câmera está desligada. |

Detalhes da customização em ARQUITETURA.md, seção 10, "Customização". **Plugins ficaram para depois do release**: plugins sem isolamento no cliente estão descartados, porque alcançariam o IPC do Tauri (captura de áudio, tela e microfone).

**Próxima: o retorno do teste externo** (lista abaixo, em "Primeiro teste externo"), começando por um novo teste com os amigos usando o diagnóstico. Depois, 14.B (APK de release assinado). As partes da etapa 14 estão em ARQUITETURA.md, seção 10, "Release".

O iOS (etapa 15, só o código) ficou para depois do lançamento.

**Testes de áudio ao vivo** (tocam som no alto-falante), em `plugins/tauri-plugin-system-audio`:
`cargo test --lib -- --ignored --nocapture --test-threads 1 exclusion_live` e `cargo test --release --lib -- --ignored --nocapture cpu_many_streams`.

**Instalador 0.2.0 (04/11/2026):** traz o retorno do teste externo (itens 1–8) e a revisão de design (A–E). Para o próximo teste, os amigos instalam a 0.2.0, o host reinicia o servidor (o protocolo mudou: `pauseConsumer`, `chat`, `color`), e quem não ouvir manda o texto de Settings › Help › Copy call diagnostics.

**Instalador Windows:** `npm run build` gera `<target>\release\bundle\nsis\Jay-C_<versão>_x64-setup.exe`. Leva ~7–9 min, por causa do LTO.

**Primeiro teste externo:** em 03/11/2026, o instalador 0.1.0 foi enviado a amigos do usuário. O servidor é hospedado pelo usuário, e eles se conectam pelo IP dele (VPN ou LAN), com as portas 3000 e 40000 liberadas. Sem assinatura de código, o SmartScreen pede "Mais informações → Executar assim mesmo". Amigos no Radmin VPN: o host é `26.36.66.63`.

**Retorno do teste externo (04/11/2026), na ordem combinada:**
1. **Bug: quem entra numa sala com gente dentro não ouve os outros, mas é ouvido.** Valia para qualquer um que entrasse depois. A pessoa via o vídeo dos outros (a rede chega), e sair e entrar de novo resolvia para ela. **Não reproduzido neste PC**, com o som medido no alto-falante (`output_meter`) em 5 cenários: dev, release com clique real e perfil limpo, primeira entrada depois de abrir o app, bot com câmera e bot saindo e voltando. Também não reproduziu pelo IP do Radmin. Para o próximo teste foi criado **Settings › Troubleshooting › Copy call diagnostics**: mede por 2 s, para cada pessoa, pacotes/s, kbps e `playedEnergy`, além do estado do player. Quem não ouvir copia o texto e manda. Pacotes chegando com `playedEnergy` 0 = o som chega mas não toca; sem pacotes = rede ou servidor.
2. Live trava com o app em foco e fica lisa no Alt+Tab. Suspeita: o app mostrando a própria tela (efeito espelho). Não medido.
3. Atalhos do Windows (tecla Windows, Win+Shift+S) param durante a live. Eles dizem que outros apps de live também causam isso, menos o Discord. Não medido.
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
7. ✅ Chat da chamada: botão **Chat** na barra (com contador de não lidas) abre um painel lateral. Mensagens novas com o painel fechado também aparecem num aviso. O servidor só repassa (`chat`, 1–500 caracteres, sem caracteres de controle) e não guarda nada: quem entra depois não vê o histórico. Verificado no app com um bot: contador, aviso, resposta digitada no teclado chegando ao bot, HTML exibido como texto, Esc fechando o painel.
8. ✅ Botões em destaque: mic, câmera e live com 64 px (os outros têm 52), "bounce" no hover e no clique em todos os botões da barra (desligado com "reduzir movimento" do sistema, que está ligado neste PC), e borda verde (#16a34a) no card de quem fala, inclusive o seu (`core/speaking.js`: -50 dBFS, 400 ms de espera; o nível vem dos analisadores do mixer). Medido no app: a borda acompanha um tom que liga e desliga a cada 1 s; o hover vai a 1,11 e assenta em 1,10, e o clique a 0,90. A sua própria borda não foi vista acender, porque ninguém falou no microfone durante o teste.

**Revisão de design (04/11/2026), inspirada no Discord:**
- ✅ A. Cor de perfil: Settings › General › Profile color (Auto pelo nome, Solid ou Gradient, com prévia). Vai aos outros no `join` e no `profile`, e o servidor só aceita `#rrggbb` e ângulo inteiro. Os cards sem câmera usam a cor de fundo, com o avatar num círculo. Quem não escolheu ganha um degradê estável pelo nome (`core/profile-color.js`). Verificado no app com 2 bots, nos temas escuro e claro: cada card com a sua cor, e a troca chegou aos dois ao vivo.
- ✅ B. Settings com abas laterais: Profile, Appearance (tema, cores, botões da chamada), Audio, Streaming (só onde há captura de som), Server e Help (diagnóstico). Numa janela estreita, as abas viram uma linha no topo. As abas vêm do helper `ui/tabs.js` (padrão ARIA: uma parada de Tab, setas, Home/End), que o guia de setup também usa. O clique direito no mic abre direto na aba Audio. Verificado no app: teclado, atalho do mic, guia, 480 px sem rolagem lateral, temas claro e escuro.
- ✅ C. Lobby com cartão de perfil e salas recentes. No topo do card, o perfil como os outros te veem (faixa na sua cor, avatar e nome), com o botão "Edit profile", que abre a aba Profile. Abaixo do campo Room, as últimas 5 salas (`core/recent-rooms.js`): um clique entra. A mensagem "room-full" deixou de dizer "4 people max" (o padrão é 16 e é configurável). Verificado no app: entrar pelo botão da sala, a sala indo para o início da lista, 360 px, temas claro e escuro.
- ✅ D. Cabeçalho da chamada: "# sala", "Just you" ou "N people" e o botão de copiar, numa pílula com fundo próprio (legível sobre qualquer degradê, nos dois temas). O cartão "Waiting for others" deixou de repetir o nome da sala. Verificado no app: "Just you" → "2 people" com um bot, a cópia mostrando o aviso, nome cortado com "…" e tooltip a 360 px, tema claro.
- ✅ E. Animações (só com o movimento do sistema liberado): diálogos e popovers entram e saem com fade (`@starting-style` + `allow-discrete`); o chat desliza; os avisos sobem; os cards novos "pulam"; a aba do Settings aparece suave; a troca de foco das lives usa View Transitions. Usam `translate`/`scale`/`opacity`, sem mexer nos `transform` de posição. Medido no app com as animações liberadas (diálogo 0,05 → 1; chat 0,28 → 1; menu 0,43 → 1; card novo com `tile-in`; foco com 15 animações de view transition) e com "reduzir movimento" (tudo instantâneo). **Settings › Appearance › Animations: System / On / Off.** System segue o Windows (este PC tem as animações desligadas, então nele só aparecem com On). `core/motion.js` resolve a escolha e o `ui/theme.js` põe `<html data-motion="full|reduced">`, que o CSS usa no lugar da media query. Medido: com o Windows reduzindo movimento, On anima (diálogo 0,4 em 50 ms, bounce 1,11); com o Windows liberando, Off para tudo.

Eles sugeriram reescrever sem o WebView ("engine própria, estilo Discord"). Recomendação dada: não. O Discord também é Chromium (Electron), e o que ele faz diferente é capturar e codificar em código nativo. Se os itens 2 e 3 apontarem para o WebView, a saída é uma etapa de captura de vídeo nativa (WGC/DXGI + H.264 por hardware).

**Android em dev** (emulador ou celular com depuração USB):
- **Modo de Desenvolvedor do Windows ligado:** o Tauri cria symlinks para a `.so` em `jniLibs`.
- `scriptsndroid-dev.ps1` recarrega PATH, `JAVA_HOME`, `ANDROID_HOME` e `NDK_HOME` e roda `tauri android dev`. O app carrega o Vite pelo IP do PC na porta 5173.
- **Servidor no emulador:** use `10.0.2.2:3000`, que é o PC visto de dentro do emulador. No celular, use o IP do PC na rede.
- **Permissões:** o app pede câmera e microfone na primeira chamada. Em testes automáticos, conceda antes com `adb shell pm grant io.github.tyxmatty.jayc.debug android.permission.CAMERA` (e `RECORD_AUDIO`).

**Ainda não verificado:**
- O instalador em outro PC, o seletor de tela real no app instalado e a conexão de amigos pela internet/VPN (aguardando o retorno do teste externo).
- Android num celular real, e o PiP no Android 8–11 (entrada pelo user-leave hint).
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
- Usar H.264 por hardware na transmissão de tela, para gastar menos CPU.
- Bundle do frontend (~58 KB gzip, a maior parte do mediasoup-client).
- O guia manda baixar o `docker-compose.yml` da página de releases e conta com a imagem publicada no GHCR. As duas coisas só existem na etapa 14.
