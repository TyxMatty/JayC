# Hospedar seu próprio servidor do Jay-C

As chamadas passam por um servidorzinho que **uma** pessoa do grupo roda no PC: quem hospeda. Leva uns 10 minutos, uma vez só. O resto da galera só conecta (a aba **Conectando**).

- Seu PC tem que estar ligado, com o servidor rodando, pra alguém conseguir ligar.
- O vídeo de todo mundo passa pelo seu PC, então sua velocidade de upload importa (vê o passo 4).

## 1. Instala o servidor

Escolhe um jeito. **O Node.js é o mais simples**, e é tudo que você precisa com Radmin VPN ou ZeroTier.

### Opção A: Node.js (recomendado)

1. Instala o **Node.js** (a versão LTS, 22 ou mais nova) pelo `nodejs.org`.
2. Pega o código do Jay-C em ZIP: na página dele no GitHub (`github.com/TyxMatty/JayC`), clica em **Code › Download ZIP**. Se a página não abrir pra você, pede o ZIP pra quem te mandou o Jay-C. Extrai numa pasta **curta**, tipo `C:\jay-c`. Pasta muito funda (tipo Downloads dentro do OneDrive) quebra a extração, porque alguns caminhos ficam grandes demais pro Windows.
3. Abre um terminal na pasta que tem o `package.json` e roda, uma vez:

```
npm install -w signaling-server
```

### Opção B: Docker

Instala o Docker Desktop pelo `docker.com` e abre ele uma vez. Depois salva o arquivo `docker-compose.yml` da página de releases do Jay-C numa pasta vazia, tipo `C:\jay-c`.

![Um PC rodando o servidor do Jay-C dentro do Docker](/assets/setup/step1_docker.svg)

## 2. Liga o servidor

**Node.js:** na mesma pasta, roda o comando abaixo e **deixa o terminal aberto**. Se fechar, o servidor para, então roda de novo sempre que for ligar.

```
npm run server
```

Quando aparecer `listening on 0.0.0.0:3000`, tá pronto. Se o Windows perguntar se o Node.js pode usar a rede, deixa. Pra atualizar depois, baixa o ZIP de novo e repete o passo 1.

**Docker:** abre um terminal na pasta do `docker-compose.yml` e roda:

```
docker compose up -d
```

Na primeira vez, o Docker baixa o servidor (uns 400 MB). Depois disso ele liga sozinho junto com o Docker. Pra atualizar, roda `docker compose pull` e o mesmo comando de novo.

![O servidor ligando num terminal](/assets/setup/step2_compose.svg)

## 3. Libera as portas

O servidor usa **duas portas**: `3000` (TCP) pra conexão e `40000` (UDP e TCP) pro áudio e vídeo. Se o firewall bloquear a segunda, a galera conecta mas ninguém se vê nem se ouve.

No Windows, abre o PowerShell **como administrador** no PC do servidor e roda:

```
New-NetFirewallRule -DisplayName "Jay-C" -Direction Inbound -Protocol TCP -LocalPort 3000,40000 -Action Allow
New-NetFirewallRule -DisplayName "Jay-C media" -Direction Inbound -Protocol UDP -LocalPort 40000 -Action Allow
```

![Portas 3000 e 40000 liberadas no firewall](/assets/setup/step3_firewall.svg)

## 4. Descobre o endereço do servidor

- **Mesma rede (em casa, LAN party):** no PC do servidor, roda `ipconfig` e usa o **Endereço IPv4**, tipo `192.168.1.50`.
- **Pela internet:** todo mundo entra na mesma rede virtual do ZeroTier ou do Radmin VPN, e você usa o endereço do PC do servidor nessa rede. Evita abrir as portas no roteador.

**Fica de olho no upload.** Todo o vídeo passa pelo PC do servidor, que manda uma cópia pra cada um que assiste. Uma live precisa de uns **5 Mbps de upload por pessoa em 1080p30** e 7,5 Mbps em 1080p60, então 15 pessoas vendo uma live em 1080p60 precisam de uns 110 Mbps. Numa LAN isso é tranquilo; pela internet, o upload de quem hospeda é o limite. Se a galera vir travando, baixa a qualidade da live.

![Amigos se conectando ao PC do servidor](/assets/setup/step4_address.svg)

## 5. Conecta e chama a galera

Nesse PC, abre **Configurações › Servidor** no Jay-C, coloca `localhost:3000` e clica em **Testar**. Quando aparecer "Conectou", escolhe um nome de sala.

Depois manda duas coisas pros amigos: o endereço do servidor do passo 4 (tipo `192.168.1.50:3000`) e o nome da sala. Eles seguem a aba **Conectando**.
