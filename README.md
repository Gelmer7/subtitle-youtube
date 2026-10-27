# SubIngles

Leitor de transcrições do YouTube numa janela separada ou aba, com tradução de palavras e linhas. O vídeo continua visível e a extensão já não mostra legendas por baixo dele: todo o texto aparece no leitor.

## Instalar

1. Abre `chrome://extensions`.
2. Liga o **Modo de programador**.
3. Clica em **Carregar sem compactação** e escolhe esta pasta (`INGLES`).

No Android, usa um navegador com suporte a extensões (por exemplo, o Quetta) e abre o YouTube no site, não na app.

## Abrir o leitor

1. Abre um vídeo do YouTube com legendas (CC).
2. Clica no ícone da extensão.

O leitor abre diretamente, sem um segundo clique. Se já estiver aberto, o clique volta a focá-lo. O leitor fica ligado à aba do YouTube. No desktop abre numa janela separada e podes pôr as duas janelas lado a lado; no mobile pode abrir numa aba, por isso alterna entre a aba do vídeo e a aba do leitor. Se minimizares a aba, o áudio continua. Mantém a aba aberta enquanto usas o leitor.

Em navegadores que não suportam `chrome.action.onClicked` (alguns Android com extensões), o popup antigo aparece por instantes e abre o leitor automaticamente.

## Leitor

- Destaca a linha e a palavra que estão a tocar.
- Faz auto-scroll; se rolarem manualmente, o seguimento suspende e retoma na linha seguinte.
- Cada linha tem um botão de play/pause. Clicar numa linha salta para o início desse trecho e reproduz.
- O botão de loop aparece na linha ativa e repete essa linha até ser desligado ou até saltar.
- O botão de tradução aparece em todas as linhas e abre/fecha a tradução completa dessa linha.
- Passar o rato numa palavra mostra a tradução; clicar fixa o popover com contexto e **Repetir frase**.
- O áudio pausa ao abrir uma tradução e retoma ao fechar, se estava a tocar.
- Controlos: tempo atual/total, retroceder 5 s, velocidade, idioma da tradução (PT/ES), tamanho do texto (Aa), seguir áudio e energia.
- O botão **Aa** abre uma barra para aumentar ou reduzir o texto sem sair do leitor.
- O botão de energia desativa a extensão e volta a mostrar o CC nativo; o leitor fica aberto e pode ser reativado no mesmo sítio.
- Se a ligação ao YouTube falhar, usa **Tentar novamente** no estado vazio ou recarrega a página do YouTube.

### Atalhos

- `Espaço`: play/pause
- `←` / `→`: recuar/avançar 5 s
- `↑` / `↓`: linha anterior/seguinte
- `[` / `]`: linha anterior/seguinte
- `Esc`: fecha o popover de tradução ou a barra do tamanho do texto

## Como funciona

1. `inject.js` corre no mundo MAIN e captura os pedidos `timedtext` do player, incluindo o token `pot` e o corpo das respostas.
2. `content.js` escolhe a faixa inglesa, descarrega as cues em `json3` e mantém o estado que o leitor consome. Já não cria a barra por baixo do vídeo.
3. `background.js` recebe o clique no ícone e abre `reader.html` diretamente numa janela ou, quando o navegador não suporta janelas de extensão, numa aba; faz a ponte de mensagens com a aba do YouTube e serve o fallback de tradução.
4. O leitor pede o estado ao content script, desenha a transcrição e envia comandos de play, pause, seek, velocidade e mute para o player.
5. O vídeo continua visível e a qualidade não é alterada. No desktop o CC nativo fica escondido para não duplicar o texto do leitor; no mobile fica visível, porque o leitor abre numa aba separada.
6. A tradução é pedida à medida das necessidades: palavras no popover e linhas no botão de tradução.

## Limitações

- **Não há modo apenas-áudio.** O vídeo continua visível e a ser descodificado; a extensão só controla a transcrição e a reprodução.
- A aba do YouTube tem de ficar **aberta**.
- Durante um anúncio, o leitor fica em espera; a transcrição retoma depois.
- Funciona em `www.youtube.com` e `m.youtube.com` (Chrome/Edge 111+ no desktop e navegadores Android com extensões, como o Quetta).
- No mobile, o leitor pode abrir numa aba; para ver o vídeo e a transcrição ao mesmo tempo é preciso split-screen ou um painel dentro da própria página.
- Vídeos sem faixa de legendas (nem automática) não têm o que mostrar.
- O erro `play-blocked` é uma política de autoplay do Chrome; pode ser preciso clicar no play da aba do YouTube, sobretudo no mobile.
- O YouTube pode mudar o player e quebrar a captura.
- A tradução do YouTube e a do Google são automáticas; a qualidade varia.
- O destaque por palavra é exato quando o YouTube fornece tempos por palavra. Nas legendas manuais, os tempos são interpolados.

## Privacidade

- As definições ficam em `chrome.storage.sync`.
- Não há analytics, contas nem histórico.
- O texto das legendas é pedido ao YouTube.
- Quando traduzes uma palavra, uma linha ou usas o fallback, esse texto é enviado ao endpoint do Google Translate. Nada é guardado num servidor da extensão.

## Estrutura

```text
manifest.json
inject.js        # captura de timedtext (mundo MAIN)
content.js       # cues, palavras e API do leitor
content.css      # esconde o CC nativo no desktop; no mobile fica visível
background.js    # janela/aba do leitor, mensagens e tradução
reader.html      # janela ou aba do modo leitura
reader.css
reader.js
popup.html/css/js # fallback para navegadores sem clique direto
icons/
```
