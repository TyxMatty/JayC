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

**Próxima: 14.B (APK de release assinado).** As partes da etapa 14 estão em ARQUITETURA.md, seção 10, "Release".

O iOS (etapa 15, só o código) ficou para depois do lançamento.

**Testes de áudio ao vivo** (tocam som no alto-falante), em `plugins/tauri-plugin-system-audio`:
`cargo test --lib -- --ignored --nocapture --test-threads 1 exclusion_live` e `cargo test --release --lib -- --ignored --nocapture cpu_many_streams`.

**Instalador Windows:** `npm run build` gera `<target>\release\bundle\nsis\Jay-C_<versão>_x64-setup.exe`. Leva ~7–9 min, por causa do LTO.

**Android em dev** (emulador ou celular com depuração USB):
- **Modo de Desenvolvedor do Windows ligado:** o Tauri cria symlinks para a `.so` em `jniLibs`.
- `scriptsndroid-dev.ps1` recarrega PATH, `JAVA_HOME`, `ANDROID_HOME` e `NDK_HOME` e roda `tauri android dev`. O app carrega o Vite pelo IP do PC na porta 5173.
- **Servidor no emulador:** use `10.0.2.2:3000`, que é o PC visto de dentro do emulador. No celular, use o IP do PC na rede.
- **Permissões:** o app pede câmera e microfone na primeira chamada. Em testes automáticos, conceda antes com `adb shell pm grant io.github.tyxmatty.jayc.debug android.permission.CAMERA` (e `RECORD_AUDIO`).

**Ainda não verificado:**
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
