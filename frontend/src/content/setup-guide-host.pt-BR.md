# Hospedar seu próprio servidor do Jay-C

As chamadas passam por um pequeno servidor que **uma** pessoa do grupo roda no PC: quem hospeda. Leva uns 10 minutos, uma vez só. Os outros só se conectam (aba **Conectar**).

- Seu PC precisa estar ligado, com o servidor rodando, pra alguém conseguir entrar.
- O vídeo de todo mundo passa pelo seu PC, então sua velocidade de upload importa (veja o passo 4).

## 1. Instale o servidor

Escolha um jeito. **O Node.js é o mais simples**, e é tudo de que você precisa com Radmin VPN ou ZeroTier.

### Opção A: Node.js (recomendado)

1. Instale o **Node.js** (a versão LTS, 22 ou mais nova) pelo `nodejs.org`.
2. Baixe o código do Jay-C em ZIP: na página dele no GitHub (`github.com/TyxMatty/Jay-C`), clique em **Code › Download ZIP**. Se a página não abrir pra você, peça o ZIP a quem te mandou o Jay-C. Extraia numa pasta **curta**, como `C:\jay-c`. Uma pasta muito funda (como Downloads dentro do OneDrive) quebra a extração, porque alguns caminhos ficam longos demais pro Windows.
3. Abra um terminal na pasta que tem o `package.json` e rode, uma vez:

```
npm install -w signaling-server
```

### Opção B: Docker

Instale o Docker Desktop pelo `docker.com` e abra o programa uma vez. Depois, salve o arquivo `docker-compose.yml` da página de releases do Jay-C numa pasta vazia, como `C:\jay-c`.

![Um PC rodando o servidor do Jay-C dentro do Docker](/assets/setup/step1_docker.svg)

## 2. Ligue o servidor

**Node.js:** na mesma pasta, rode o comando abaixo e **deixe o terminal aberto**. Se você fechar, o servidor para, então rode de novo sempre que for ligar.

```
npm run server
```

Quando aparecer `listening on 0.0.0.0:3000`, está pronto. Se o Windows perguntar se o Node.js pode usar a rede, permita. Pra atualizar depois, baixe o ZIP de novo e repita o passo 1.

**Docker:** abra um terminal na pasta do `docker-compose.yml` e rode:

```
docker compose up -d
```

Na primeira vez, o Docker baixa o servidor (uns 400 MB). Depois disso, ele liga sozinho junto com o Docker. Pra atualizar, rode `docker compose pull` e o mesmo comando de novo.

![O servidor ligando num terminal](/assets/setup/step2_compose.svg)

## 3. Libere as portas

O servidor usa **duas portas**: `3000` (TCP) pra conexão e `40000` (UDP e TCP) pro áudio e o vídeo. Se o firewall bloquear a segunda, os outros conectam, mas ninguém se vê nem se ouve.

No Windows, abra o PowerShell **como administrador** no PC do servidor e rode:

```
New-NetFirewallRule -DisplayName "Jay-C" -Direction Inbound -Protocol TCP -LocalPort 3000,40000 -Action Allow
New-NetFirewallRule -DisplayName "Jay-C media" -Direction Inbound -Protocol UDP -LocalPort 40000 -Action Allow
```

![Portas 3000 e 40000 liberadas no firewall](/assets/setup/step3_firewall.svg)

## 4. Descubra o endereço do servidor

- **Mesma rede (em casa, LAN party):** no PC do servidor, rode `ipconfig` e use o **Endereço IPv4**, como `192.168.1.50`.
- **Pela internet:** todo mundo entra na mesma rede virtual do ZeroTier ou do Radmin VPN, e você usa o endereço do PC do servidor nessa rede. Assim não é preciso abrir portas no roteador.

**Fique de olho no upload.** Todo o vídeo passa pelo PC do servidor, que manda uma cópia pra cada pessoa que assiste. Uma live precisa de uns **5 Mbps de upload por pessoa em 1080p30** e 7,5 Mbps em 1080p60; então, 15 pessoas vendo uma live em 1080p60 precisam de uns 110 Mbps. Numa LAN isso é tranquilo; pela internet, o upload de quem hospeda é o limite. Se a imagem travar pros outros, baixe a qualidade da live.

![Amigos se conectando ao PC do servidor](/assets/setup/step4_address.svg)

## 5. Conecte e chame seus amigos

Nesse PC, abra **Configurações › Servidor** no Jay-C, coloque `localhost:3000` e clique em **Testar**. Quando aparecer "Conectou", escolha um nome de sala.

Depois, mande duas coisas pros amigos: o endereço do servidor do passo 4 (como `192.168.1.50:3000`) e o nome da sala. Eles seguem a aba **Conectar**.
