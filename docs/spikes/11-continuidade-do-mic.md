# Continuidade do microfone nativo: do Channel até a faixa

**Data:** 2026-11-06 · **Máquina:** Ryzen 5 5600G (6 núcleos, 12 threads), Windows 11 (build 26300), WebView2 157.0.4341.42, app de dev (build de debug), fora de chamada
**Código:**
- `scripts/mic-continuity.js`: a medição, rodada pelo `cdp-eval`.
- `frontend/src/core/pcm-player.worklet.js`: a correção e os contadores.
- `frontend/test/pcm-player.test.js`: os testes do worklet.

## Pergunta

Na I2 do Jay-A ([JAY-A.md](../JAY-A.md), seção 9), o Jay-A falso mandava um tom de 440 Hz. Um gravador ScriptProcessor ligado à faixa do microfone, dentro do app, achou 4,6 % de blocos de 10,7 ms que "não eram tom puro". O áudio que chegava ao JS era contínuo. A pergunta: o caminho do Channel até a faixa introduz descontinuidades? O caminho é este:

```
Channel → native-mic.js → PcmTrackSource.push → pcm-player.worklet.js → MediaStreamAudioDestinationNode → faixa
```

É o mesmo caminho do microfone nativo no modo Jay-C e do som da live.

## Como foi medido

- **Sinal:** o Jay-A falso num pipe próprio (`--pipe`), com o app usando `JAYC_JAY_A_PIPE`. O pipe de verdade estava em uso por outra sessão de teste.
- **Quatro pontos de gravação**, no mesmo teste:
  - **IN:** os blocos que chegam ao JS;
  - **P1:** a saída do worklet, no próprio AudioContext dele;
  - **P2:** a faixa, lida em outro AudioContext por um AudioWorklet;
  - **P3:** a faixa, lida em outro AudioContext por um ScriptProcessor de 512, como o gravador da I2.
- **Detector exato:** um tom puro obedece a `x[n] = 2cos(w)·x[n−1] − x[n−2]`. Qualquer amostra pulada, repetida ou zerada deixa um resíduo acima de 10⁻³. O resíduo normal é de ~10⁻⁷. Para cada evento, a diferença de fase antes e depois dá quantas amostras foram puladas ou repetidas (módulo um período, 109,1 amostras).
- **O teste do gravador da I2** também foi aplicado: Goertzel a 440 Hz em blocos de 512, razão < 0,8.
- **Contadores no worklet**, lidos pela `port` (`PcmTrackSource.stats()`): blocos descartados, saltos, underruns, quadros de silêncio e o tamanho da fila.
- **Parada da thread principal:** um laço ocupado de 150 ou 300 ms no meio da medição.

## Resultado 1: em regime, o caminho é exato; quem inventa é o ScriptProcessor

60 s, versão final do worklet, sem nenhuma parada maior que 48 ms:

| ponto | eventos | teste da I2 (blocos "não puros") |
|---|---|---|
| IN (chega ao JS) | 0 | 0 / 5 536 |
| P1 (saída do worklet) | 0 | 0 / 5 529 |
| P2 (faixa → AudioWorklet) | 1: um buraco de 10 ms que não existe em P1 | 2 / 5 523 |
| P3 (faixa → ScriptProcessor) | 47 | 22 / 5 514 |

- **Nenhum evento** de P3 está em P1. Todos são um salto de 18,9 amostras, que é 128 módulo 109,1: o ScriptProcessor perde ou repete um quantum inteiro de 128 quadros, ~0,8 vez por segundo. Ele roda na thread principal. Com a página mais ocupada (numa chamada), deve perder mais; os 4,6 % da I2 não foram reproduzidos, porque não houve chamada.
- **P2** também perde algo de vez em quando (um bloco de 10 ms em 60 s): é a passagem da faixa para outro AudioContext. Isso é do medidor; o WebRTC lê a faixa por outro caminho, que não foi medido aqui.
- **O bot da I2** media com um ScriptProcessor de 1024. Os números dele dizem pouco sobre o caminho.

## Resultado 2: depois de uma parada da thread principal, a fila ficava alta para sempre

Os blocos só chegam ao worklet pela thread principal. Quando ela para por mais tempo que a fila (~40–60 ms), o worklet seca e fica em silêncio. Depois, recebe de uma vez tudo o que se acumulou. Na versão antiga:

- a fila ficava com o que a rajada trouxe, até 250 ms, e **nunca mais diminuía**: o microfone passava a sair ~220 ms atrasado pelo resto da chamada;
- acima de 250 ms, o worklet descartava o bloco mais antigo, mesmo que estivesse tocando: um corte seco.

Medido com a versão antiga (só com os contadores a mais):

| caso | silêncio | blocos descartados (cortes secos) | fila depois |
|---|---|---|---|
| parada de 300 ms, injetada | 271 ms | 5 (2 cortes) | ~220 ms até o fim (30 s) |
| paradas de 127–158 ms ao abrir a página, naturais | 41 ms | 38 | ~220 ms até o fim (45 s) |
| parada natural de 733 ms (máquina ocupada) | 800 ms | 9 | ~220 ms até o fim (20 s) |

**Paradas assim são comuns.** Nas rodadas deste spike, a thread principal do WebView parou por mais de 60 ms ao abrir a página (127–158 ms). Com outras compilações rodando na máquina, isso aconteceu 8 vezes em 60 s (61–196 ms), e uma vez chegou a 733 ms. Então é provável que quase toda chamada caia nisso logo na primeira parada. Isso pode ter relação com as queixas de engasgos, mas a ligação não foi medida.

## Correção (`pcm-player.worklet.js`)

- **A rajada que vem depois de uma parada vira reserva:** até 250 ms. Assim, uma parada parecida logo depois não seca a fila. O teste "a cushion that keeps being needed stays" cobre isso: uma parada de 150 ms a cada 8 s nunca seca.
- **A reserva que não foi usada sai:** a cada 10 s, se a fila nunca desceu de 80 ms (60 ms + 20 ms de folga), ela pula o excesso. Assim, o ponto mais baixo da janela volta a ser 60 ms.
- **Tocando, acima de 250 ms,** ela pula de volta para 60 ms.
- **O pulo é um crossfade de 128 quadros (2,7 ms),** não um corte seco.
- **O descarte seco do bloco mais antigo** só sobra em dois casos:
  - fora da reprodução, quando nada está tocando;
  - tocando, acima de 1 s, quando a thread de áudio parou.
- **Contadores:** `PcmTrackSource.stats()`.

Medido com a versão final, nas mesmas condições:

| caso | silêncio | cortes secos | pulos (crossfade) | fila depois |
|---|---|---|---|---|
| em regime, 60 s | 0 | 0 | 0 | 28–89 ms (mediana 68) |
| parada de 300 ms, rajada aos poucos | 229 ms | 0 | 1, logo na volta (249 ms) | ~50 ms, e 36 s sem nenhum evento |
| parada de 300 ms, rajada inteira antes de voltar a tocar | 269 ms | 0 (5 blocos descartados ainda no silêncio) | 0 | ~220 ms, reserva até a janela seguinte (≤ 20 s) |
| parada de 150 ms | 89 ms | 0 | 1, 12 s depois (88 ms) | 60–90 ms |
| máquina ocupada: 8 paradas naturais de 61–196 ms em 60 s | 92 ms em 2 vezes | 0 | 0 | subiu para ~220 ms depois da de 196 ms (reserva) |

**O silêncio durante a parada continua.** Enquanto a thread principal está parada, nenhum áudio chega ao worklet. Para evitar isso, o áudio teria que chegar ao worklet sem passar pela thread principal, ou a fila fixa teria que ser maior, com mais atraso. Nenhuma das duas coisas foi feita.

## O que não foi medido

- **Os 4,6 % da I2:** eles vieram de uma chamada, com a interface rodando. Aqui não houve chamada.
- **O codificador e a rede:** a faixa que vai para o WebRTC é a mesma que P1 e P2 medem. Não houve chamada, então não houve medição do outro lado.
- **Diferença de relógio** entre o microfone (WASAPI) e o AudioContext:
  - com o falso, que usa o relógio do sistema, a fila ficou estável por 60 s;
  - com um microfone de verdade, uma diferença apareceria como uma fila que seca aos poucos (um underrun a cada tantos minutos) ou que cresce (aí a janela de 10 s corta). Isso não foi medido.
- **O microfone de verdade no modo Jay-C:** ele passa pelo mesmo worklet, mas não tem um sinal conhecido para achar descontinuidades.
- **O ritmo dos blocos:** eles chegam no ritmo dos quadros da página, não a cada 20 ms. Os intervalos medidos: p50 de 16 ms, p99 de 34 ms. Os 60 ms de início cobrem isso.

## Reproduzir

```bash
cargo run --example fake_jay_a --features fake-jay-a -- --pipe jay-a-link-teste
```

No plugin (`plugins/tauri-plugin-system-audio`). Depois, abra o app de dev (`scripts/dev-debug.ps1`) com `JAYC_JAY_A_PIPE=jay-a-link-teste` no ambiente, e rode:

```bash
node scripts/cdp-eval.mjs scripts/mic-continuity.js
```

`STALL_AT` e `STALL_MS`, no topo do script, injetam uma parada da thread principal.
