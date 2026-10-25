# legrendas

Extensão mínima para estudar inglês no YouTube: as legendas ficam **abaixo do vídeo**, numa barra preta, em vez de cobrirem a imagem.

```
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

## Usar

- A extensão liga o CC sozinho e esconde as legendas nativas.
- A linha de cima é o inglês; a de baixo é a tradução.
- Clica no ícone da extensão para escolher:
  - **Português (Brasil)** ou **Español**;
  - mostrar ou esconder a linha traduzida;
  - tamanho da letra;
  - em fullscreen: encolher o vídeo ou esconder as legendas.
- A barra cresce automaticamente com o texto.

## Como funciona

1. `inject.js` corre no mundo MAIN e interceta os pedidos `timedtext` do player. Hoje o YouTube exige um token `pot` nesses pedidos; a extensão reaproveita a URL e, principalmente, guarda o **corpo da resposta** que o player já recebeu. Assim não depende de um segundo pedido com o token certo.
2. `content.js` escolhe a faixa inglesa, usa as cues capturadas (ou descarrega-as em `json3`) e pede a versão traduzida com `tlang=pt-BR` (ou `es`).
3. A tradução é alinhada por tempo com a cue inglesa que está a tocar.
4. A barra é inserida depois de `#player`, antes de `#below`, num Shadow DOM. O vídeo não é alterado.
5. Em fullscreen, o vídeo é reduzido pela altura da barra e a barra ocupa a faixa preta de baixo.

Se o `tlang` não devolver tradução, o `background.js` usa o endpoint do Google Translate como fallback.

## Limitações

- Só funciona em `youtube.com/watch` e `/live/` no desktop (Chrome/Edge 111+). Shorts, embeds e miniplayer ficam de fora.
- Vídeos sem faixa de legendas (nem automática) não têm o que mostrar.
- Legendas queimadas no vídeo não podem ser escondidas.
- O YouTube pode mudar o player e quebrar a captura. As camadas de fallback tentam sempre mostrar a legenda nativa.
- A tradução do YouTube é automática; a qualidade varia.

## Privacidade

- As definições ficam em `chrome.storage.sync`.
- Não há analytics, contas nem histórico.
- O texto das legendas é pedido ao YouTube; quando é preciso o fallback, o texto é enviado ao endpoint do Google Translate. Nada é guardado num servidor da extensão.

## Estrutura

```
manifest.json
inject.js        # captura de timedtext (mundo MAIN)
content.js       # barra, cues, sincronização, fullscreen
content.css      # esconder CC nativo + fullscreen
background.js    # fallback de tradução
popup.html/css/js
icons/
```

## Teste

Vídeo de teste usado durante o desenvolvimento:

https://www.youtube.com/watch?v=eyZEqSPeMwg
