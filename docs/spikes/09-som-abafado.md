# Som abafado ao entrar numa chamada (Windows)

**Data:** 2026-11-02 · **Máquina:** notebook Acer, Windows 11 (build 26300), alto-falantes e fones Realtek com fio, microfone Intel Smart Sound, Acer PurifiedVoice instalado
**Ferramentas:** [`output_meter`](../../plugins/tauri-plugin-system-audio/examples/output_meter.rs) mede o loopback do alto-falante padrão, isto é, o que de fato sai depois da mixagem. [`mic_open`](../../plugins/tauri-plugin-system-audio/examples/mic_open.rs) abre o microfone com WASAPI puro.

## Sintoma

Com o Jay-C numa chamada, o som dos outros apps (música, jogo) fica muito abafado.

## Medições

Um tom estéreo tocou em outro processo durante todo o teste. O nível é o que saiu no alto-falante:

| Situação | Nível do tom |
|---|---|
| Sem chamada | −7,8 dB |
| Jay-C em chamada, microfone com processamento de voz padrão | **−73 dB**, com quedas a −96,9 dB (silêncio total) quando o dispositivo é reconfigurado |
| Jay-C em chamada, `echoCancellation`, `noiseSuppression` e `autoGainControl` desligados | **−73 dB** (igual) |
| Jay-C em chamada + `SetDuckingPreference(TRUE)` nas sessões do WebView2 | **−73 dB** (igual) |
| Microfone aberto com **WASAPI puro**, por outro processo | **−7,8 dB**, sem efeito nenhum |

Ao sair da chamada, o tom volta a −7,8 dB na hora.

## Conclusões

- **Não é o ducking padrão do Windows.** Ele reduziria cerca de 14 dB, de forma constante, e o opt-out oficial (`SetDuckingPreference`) não mudou nada. O que acontece aqui é uma queda de ~65 dB que se "adapta", com picos a −19 dB que somem em ~1 s, mais a reconfiguração do dispositivo. É o comportamento de um **supressor de ruído por IA aplicado à saída**, que entra em ação quando há uma chamada. O Acer PurifiedVoice faz isso no alto-falante.
- **O gatilho é o jeito como o WebView2/Chromium abre o microfone**, como fluxo de comunicação. Um WASAPI simples, sem essa marcação, não dispara a supressão. Desligar o processamento de voz do `getUserMedia` também não evita.
- Não há opção do Chromium ou do WebView2 conhecida que mude a categoria do microfone.

## Caminhos

1. **Configuração do usuário:** desligar a redução de ruído **da saída** (alto-falante) no Acer PurifiedVoice, pelo Acer Quick Access ou QuickPanel, e/ou os aprimoramentos de áudio do dispositivo no Windows.
2. **No app, como o Discord faz:** capturar o microfone em Rust com WASAPI puro, que comprovadamente não dispara a supressão, e mandá-lo ao WebRTC pela mesma ponte do áudio da tela. O usuário confirmou que **o Discord não causa o abafamento**. O Discord captura o microfone com o próprio motor de voz nativo, não com o `getUserMedia` do Chromium, o que bate com a medição acima. A correção do texto anterior: eu tinha afirmado, sem medir, que o Discord também disparava a supressão. O custo é que o cancelamento de eco e a supressão de ruído do WebRTC só se aplicam a faixas vindas do `getUserMedia`, então o caminho nativo precisa do próprio cancelamento de eco, como o motor do Discord tem.

## Solução implementada: microfone nativo com o processamento de áudio do WebRTC

No Windows, o microfone da chamada não usa mais o `getUserMedia`:
1. O plugin `system-audio` captura o microfone com **WASAPI puro**.
2. O áudio passa pelo **AudioProcessing do WebRTC** (o mesmo do Chromium e do Discord), que faz o cancelamento de eco (AEC3), a supressão de ruído e o ganho automático.
3. Ele chega ao WebView pelo mesmo `PcmTrackSource` do áudio da tela.

A **referência de eco** é um loopback da árvore do WebView2 do próprio Jay-C. É exatamente o que o app toca (as vozes), e não inclui a música ou o jogo do usuário.

A biblioteca, em `third_party/webrtc-audio-processing` (BSD), é compilada pelo `build.rs` com Meson e MSVC. Duas particularidades:
- MSVC exige C++20 por causa dos inicializadores designados; o abseil fica em C++17.
- O build roda numa pasta curta, para contornar o limite de 260 caracteres de caminho.

Uma pequena camada C (`native/jayc_apm.cpp`) evita depender do `bindgen`.

| Medição | Resultado |
|---|---|
| Tom de outro app com o Jay-C em chamada, microfone nativo | **−7,8 dB**, estável. Sem abafamento; antes era −73 dB. |
| Teste determinístico (`cargo test`): eco linear de 40 ms a −6 dB, sinal de banda larga parecido com voz, sem supressão de ruído nem AGC | eco residual de −35,0 dB sem AEC contra **−68,2 dB com AEC (33 dB removidos)** |
| Teste acústico nesta máquina (alto-falante → microfone) | inconclusivo: mesmo com AEC e supressão de ruído desligados, o microfone Intel Smart Sound, com o PurifiedVoice na entrada, não capta o som dos alto-falantes (−118 dB a 1500 Hz). Ou o próprio hardware já remove o eco, ou o som estava saindo nos fones. |

Observação: o primeiro teste determinístico usava tons puros e mostrou só 8 dB de remoção. Tons puros têm banda estreita demais para o filtro adaptativo aprender o caminho do eco. Com o sinal de banda larga, a remoção chegou a 33 dB. O AGC também precisa ficar desligado na comparação, porque ele aumenta o resíduo quando o eco some.

Opções do `start_mic`: `echoCancellation`, `noiseSuppression` e `autoGainControl`, todas ligadas por padrão. Ainda não aparecem na tela de Settings.
