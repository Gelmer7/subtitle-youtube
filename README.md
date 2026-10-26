# legrendas

Extensão para estudar inglês no YouTube: legendas numa barra preta **abaixo do vídeo** e um **Modo leitura** numa janela separada, com a transcrição completa, o áudio do vídeo e tradução ao clicar nas palavras.

```text
┌──────────────────────────────────────┐
│                                      │
│                VÍDEO                 │
│                                      │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│  English original line               │
│  Linha traduzida em português        │
└──────────────────────────────────────┘
   Título / descrição / comentários
```

## Instalar

1. Abre `chrome://extensions`.
2. Liga o **Modo de programador**.
3. Clica em **Carregar sem compactação** e escolhe esta pasta (`INGLES`).
4. Abre um vídeo do YouTube com legendas (CC).

## Usar a barra

- A extensão liga o CC sozinho e esconde as legendas nativas.
- A linha de cima é o inglês; a de baixo é a tradução.
- Clica no ícone da extensão para escolher:
  - **Português (Brasil)** ou **Español**;
  - mostrar ou esconder a linha traduzida;
  - tamanho da letra;
  - em fullscreen: encolher o vídeo ou esconder as legendas.
- A barra cresce automaticamente com o texto.

## Modo leitura

Abre de duas formas:

- no popup, em **Modo leitura → Abrir janela**;
- na barra de legendas, no pequeno botão **Texto** no canto superior direito.

O que faz:

- abre uma janela só com a transcrição, sem o vídeo;
- destaca a linha e a palavra que estão a tocar;
- faz auto-scroll suave; se rolarem manualmente, o seguimento pausa e podem reativá-lo em **Seguir áudio**;
- mostra a tradução por baixo de cada linha (respeita a opção **Mostrar a linha traduzida**);
- clicar numa palavra abre um popover com a tradução;
- **Repetir frase** salta para o início da frase e volta a tocar;
- clicar no horário de uma linha salta o áudio para esse ponto;
- controlos: play/pause, ±5 s, linha anterior/seguinte, velocidade, som, tradução, pausa ao traduzir e seguir áudio;
- botão **Ecrã inteiro** para focar apenas no texto.

### Pausar ao traduzir

Por omissão, o áudio continua quando se abre a tradução de uma palavra.

Com o switch **Pausar ao traduzir** ligado:

1. clicar numa palavra pausa o áudio;
2. o áudio retoma quando o popover fecha, se estava a tocar;
3. se o áudio já estava pausado, continua pausado;
4. **Repetir frase** salta e toca sempre.

A preferência fica guardada.

### Atalhos na janela do leitor

- `Espaço`: play/pause
- `←` / `→`: recuar/avançar 5 s
- `[` / `]`: linha anterior/seguinte
- `Esc`: fecha o popover de tradução

## Como funciona

1. `inject.js` corre no mundo MAIN e interceta os pedidos `timedtext` do player. Hoje o YouTube exige um token `pot`; a extensão reaproveita a URL e, principalmente, guarda o **corpo da resposta** que o player já recebeu.
2. `content.js` escolhe a faixa inglesa, descarrega as cues em `json3` e a versão traduzida com `tlang=pt-BR` (ou `es`). Também guarda os tempos de cada palavra e agrupa cues curtas em frases legíveis.
3. A barra é inserida depois de `#player`, antes de `#below`, num Shadow DOM. O vídeo não é alterado.
4. O **Modo leitura** abre `reader.html` numa janela da extensão. A janela do leitor fala com a aba do YouTube através de `background.js`.
5. O leitor pede o estado ao content script, desenha a transcrição e envia comandos de play, pause, seek, velocidade e mute de volta para o player.
6. No modo leitura, o vídeo é escondido e a qualidade do player é baixada para a mais baixa disponível. Ao fechar a janela, o vídeo e a qualidade anterior são restaurados.
7. Se o `tlang` não devolver tradução, o `background.js` usa o endpoint do Google Translate como fallback. O mesmo endpoint serve as traduções das palavras clicadas.

## Limitações importantes

- **Não existe áudio-only real.** O YouTube entrega áudio e vídeo no mesmo player. O modo leitura esconde a imagem e força a qualidade mais baixa, mas o vídeo pode continuar a ser descodificado em segundo plano. O CPU não fica necessariamente a zero.
- A aba do YouTube tem de ficar **aberta**. Pode ser minimizada. Se for fechada, o texto já carregado continua visível, mas o áudio para.
- Durante um anúncio, a imagem volta a aparecer na aba do YouTube para poderes saltar; a sincronização da transcrição pausa e retoma depois.
- Só funciona em `youtube.com/watch` e `/live/` no desktop (Chrome/Edge 111+). Shorts, embeds e miniplayer ficam de fora.
- Vídeos sem faixa de legendas (nem automática) não têm o que mostrar.
- Legendas queimadas no vídeo não podem ser escondidas.
- O YouTube pode mudar o player e quebrar a captura. As camadas de fallback tentam sempre mostrar a legenda nativa.
- A tradução do YouTube e a do Google são automáticas; a qualidade varia.
- O destaque por palavra é exato quando o YouTube fornece tempos por palavra. Nas legendas manuais, os tempos são interpolados pela duração da frase.

## Privacidade

- As definições ficam em `chrome.storage.sync` (e as preferências do leitor também).
- Não há analytics, contas nem histórico.
- O texto das legendas é pedido ao YouTube.
- Quando é preciso o fallback de tradução, ou quando clicas numa palavra, esse texto é enviado ao endpoint do Google Translate. Nada é guardado num servidor da extensão.

## Estrutura

```text
manifest.json
inject.js        # captura de timedtext (mundo MAIN)
content.js       # barra, cues, palavras, modo áudio e API do leitor
content.css      # esconder CC nativo, fullscreen e overlay do leitor
background.js    # janela do leitor, mensagens e fallback de tradução
reader.html      # janela do modo leitura
reader.css
reader.js
popup.html/css/js
icons/
```

## Teste

Vídeo de teste usado durante o desenvolvimento:

https://www.youtube.com/watch?v=eyZEqSPeMwg
