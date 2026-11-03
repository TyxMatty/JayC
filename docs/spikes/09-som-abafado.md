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

1. **Configuração do usuário (sem custo):** desligar a redução de ruído **da saída** (alto-falante) no Acer PurifiedVoice, pelo Acer Quick Access ou QuickPanel, e/ou os aprimoramentos de áudio do dispositivo no Windows. Isso vale para todos os apps de chamada: Discord, Teams e o Chrome também disparam a supressão.
2. **No app:** capturar o microfone em Rust com WASAPI puro, que comprovadamente não dispara a supressão, e mandá-lo ao WebRTC pela mesma ponte do áudio da tela. O custo é **perder o cancelamento de eco e a supressão de ruído do WebRTC**, porque eles só se aplicam a faixas vindas do `getUserMedia`. Nesse modo é preciso usar fone, senão os outros ouvem o próprio eco.
