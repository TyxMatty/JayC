# Jay-C

**Português** · [English](README.en.md)

App leve e open-source de chamadas e compartilhamento de tela para desktop e mobile, com servidor de sinalização self-hosted via Docker.

## Baixar

O instalador para Windows está nos **[releases](https://github.com/TyxMatty/JayC/releases/latest)**: baixe o `Jay-C_<versão>_x64-setup.exe` da versão mais recente. Ele atualiza uma versão anterior por cima e mantém as configurações. Todas as versões ficam em [releases](https://github.com/TyxMatty/JayC/releases).

## Código

| Pasta | Conteúdo |
|---|---|
| [`signaling-server/`](signaling-server/) | Servidor de sinalização (Node.js + `ws`) e SFU de mídia (mediasoup), com arquivos Docker |
| [`frontend/`](frontend/) | App Tauri v2 + Vanilla JS (Vite) |
| [`plugins/tauri-plugin-system-audio/`](plugins/tauri-plugin-system-audio/) | Captura de áudio por processo para as transmissões (Windows) |
| `plugins/tauri-plugin-pip/` | Plugin de Picture-in-Picture para Android/iOS *(em construção)* |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Arquitetura, decisões técnicas e etapas |
| [`docs/CONTINUAR.md`](docs/CONTINUAR.md) | Instalar num PC novo, estado atual e próximos passos |
| [`scripts/`](scripts/) | Ferramentas de desenvolvimento: app com depuração, rodar JS no app real, tom de teste |

## Rodando o app

```bash
npm install
npm run dev
```

Esse comando abre a janela do Jay-C (Tauri) com recarregamento automático. Para abrir só a interface no navegador, sem Tauri, use `npm run web`. A primeira compilação do Rust leva alguns minutos.

No Windows, o build também precisa de **Python com Meson e Ninja** (`py -m pip install --user meson ninja`, com a pasta de Scripts do Python no PATH). Eles compilam o processamento de áudio do WebRTC, usado pelo microfone. O primeiro build baixa o abseil-cpp e leva alguns minutos a mais.

## Rodando o servidor localmente

```bash
npm install
npm run server
```

O servidor usa a porta **3000/tcp** para a sinalização (`ws://`) e a **40000** (UDP e TCP) para a mídia. Libere as duas no firewall. O health check fica em `http://localhost:3000/health`.

## Rodando o servidor com Docker

Dentro do repositório, o comando abaixo gera a imagem a partir do código-fonte:

```bash
docker compose -f signaling-server/docker-compose.yml up -d --build
```

Usuários finais só precisam do `docker-compose.yml` numa pasta vazia e de `docker compose up -d`. A imagem é baixada do registry, que ainda vai ser publicado na etapa de release.

## Testes

```bash
npm test
```
