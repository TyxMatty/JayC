# Spike 06: captura para transmissões (Windows)

**Data:** 2026-11-02 · **Máquina:** Windows 11 (build 26300), WebView2 156, Tauri 2.12, crate `wasapi` 0.26
**Código:** [`frontend/src-tauri/src/spike.rs`](../../frontend/src-tauri/src/spike.rs), [`frontend/src/spike/`](../../frontend/src/spike/), [`frontend/src-tauri/examples/loopback_probe.rs`](../../frontend/src-tauri/examples/loopback_probe.rs)

O código do spike foi removido na etapa 9, quando virou [`plugins/tauri-plugin-system-audio`](../../plugins/tauri-plugin-system-audio/). Ele continua disponível no histórico do git, no commit `5aa27f4`.

## Conclusão

**Viável. O desenho da seção 6 da arquitetura se mantém, e o Plano B não é necessário.**

## 1. Qual janela o `getDisplayMedia` escolheu?

O seletor nativo do WebView2 abre normalmente dentro do Tauri. O rótulo e o `deviceId` da faixa de vídeo identificam a fonte:

| Escolha | `track.label` | `displaySurface` |
|---|---|---|
| Janela | `window:1835810:0` (HWND em decimal) | `window` |
| Tela inteira | `screen:0:0` | `monitor` |

O HWND passa por `GetWindowThreadProcessId`, que devolve o PID da janela (ex.: `Discord.exe` 17388). O Plano A está confirmado.

## 2. Áudio do próprio `getDisplayMedia` (para comparar)

- **Janela:** nenhuma faixa de áudio.
- **Tela inteira:** faixa "System Audio" **mono**, com `echoCancellation`, `noiseSuppression` e `autoGainControl` **ligados**, o que estraga música. Ela inclui tudo, até as vozes da chamada (`restrictOwnAudio: false`).

Isso confirma a decisão de capturar o áudio de forma nativa.

## 3. Apps tocando som (sessões de áudio)

`IAudioSessionManager2` no dispositivo padrão listou Brave, Chrome, Discord (2 sessões), Claude, `audiodg` e outros.

- O PID da sessão costuma ser um **processo filho** do app:
  - Brave: o áudio sai do 15320, filho do `brave.exe` 14032.
  - Discord: o áudio sai do 14964, filho do 17388, que é o PID da janela.
- **O WebView2 do Jay-C aparece como filho do `jay-c.exe`**, e foi marcado como `is_self_tree`. Portanto, excluir a árvore do Jay-C exclui as vozes da chamada.
- ⚠️ O pico por sessão (`IAudioMeterInformation`) retornou 0 em todas, mesmo com música tocando. Para mostrar "tocando agora" em Settings, usar o estado `active` da sessão.

## 4. Captura por processo (WASAPI process loopback)

Formato: float32, 48 kHz, estéreo, modo por eventos com `autoconvert`. Captura de 4 s em cada teste, com música tocando no Brave:

| Alvo | Modo | Pico | RMS | Leitura |
|---|---|---|---|---|
| Jay-C (36752) | EXCLUDE | 0,51–0,79 | 0,10–0,13 | "tudo menos o Jay-C" ✅ |
| Brave principal (14032) | INCLUDE | 0,81 | 0,097 | só o app escolhido ✅ |
| Áudio do Brave (15320) | INCLUDE | 0,81 | 0,097 | o filho também funciona |
| Discord (17388, em silêncio) | INCLUDE | 0,000 | 0,000 | isola, não vaza o Brave ✅ |
| Brave principal (14032) | EXCLUDE | 0,000 | 0,000 | só o Brave tocava ✅ |

As quatro últimas linhas rodaram **ao mesmo tempo**. Vários streams simultâneos funcionam, então dá para misturar "tudo menos X e Y".

## Decisões para as etapas 8 a 10

1. **Modo janela:** `label` → HWND → PID da janela → um stream INCLUDE dessa árvore. O processo da janela é a raiz e o áudio sai de um filho, que fica incluído.
2. **Tela inteira sem exclusões:** um stream EXCLUDE da árvore do **navegador do WebView2** (ver a correção abaixo).
3. **Tela inteira com exclusões:**
   - Abrir um stream INCLUDE por **app raiz** com sessão de áudio, subindo pelos ancestrais até o processo mais alto com o mesmo `exe`.
   - Pular a árvore do Jay-C e os `exe` excluídos.
   - Misturar em Rust e reavaliar quando surgir uma sessão nova.
4. Desligar `echoCancellation`, `noiseSuppression` e `autoGainControl` em tudo que for áudio de transmissão.
5. Ainda não testado: sincronia A/V, apps cujo áudio sai de um processo fora da árvore e o custo de CPU de ~10 streams simultâneos. Fica para medir nas etapas 9 e 10.

## Correção encontrada na etapa 9: a árvore do Jay-C não inclui o WebView2

O spike mostrou que "EXCLUDE do Jay-C" capturava áudio de outros apps, mas o Jay-C não estava tocando nada naquele momento. Na etapa 9, o teste de ponta a ponta usou uma "voz" de 1500 Hz tocada pelo Jay-C e mostrou que **ela vazava**. Medição com INCLUDE em cada nível da cadeia de processos:

| Captura INCLUDE de… | Voz de 1500 Hz tocada pelo Jay-C |
|---|---|
| `jay-c.exe` (35344) | silêncio (−120 dB) |
| `msedgewebview2.exe`, navegador do WebView2 (26196, filho do 35344) | −10 dB |
| `msedgewebview2.exe`, serviço de áudio (4780, filho do 26196) | −10 dB |

Para o loopback do Windows, a "árvore de processos" do `jay-c.exe` **não** inclui os processos do WebView2, embora a lista de processos os mostre como filhos. A árvore do processo navegador do WebView2 inclui o serviço de áudio.

**Correção:** o modo "tudo menos o Jay-C" exclui a árvore do `msedgewebview2.exe` que é filho direto do Jay-C. Todo o som do app sai do WebView2. Depois da correção, a voz caiu para −136/−153 dB, ou seja, ausente, enquanto o tom de teste continuou chegando.
