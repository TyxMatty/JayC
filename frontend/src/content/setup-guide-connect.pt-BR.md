# Entrar no servidor de um amigo

Alguém do grupo hospeda o servidor (a aba **Hospedando**). Você não instala nada além do Jay-C: só precisa do endereço do servidor e do nome de uma sala.

## 1. Pega o endereço

Pede pra quem hospeda o endereço do servidor e o nome da sala. O endereço é tipo `192.168.1.50:3000`.

- **Mesma rede** (em casa, LAN party): é só isso.
- **Pela internet:** antes, entra na mesma rede do ZeroTier ou do Radmin VPN de quem hospeda, e usa o endereço que ele te passar nessa rede.

![Amigos se conectando ao PC do servidor](/assets/setup/step4_address.svg)

## 2. Conecta o app

Abre **Configurações › Servidor**, coloca o endereço com a porta e clica em **Testar**. Quando aparecer "Conectou", digita o nome da sala no lobby e entra: todo mundo que entrar com o mesmo nome de sala cai na mesma chamada.

![Configurações › Servidor com um endereço funcionando](/assets/setup/step5_connect.png)

## Se não funcionar

- **"Sem resposta" ou "Não conectou":** confere o endereço com quem hospeda. Pode ser que o servidor não esteja rodando, ou que o firewall dele esteja bloqueando a porta `3000`.
- **Você entra, mas não vê nem ouve ninguém:** o firewall de quem hospeda tá bloqueando a porta `40000` (passo 3 da aba **Hospedando**).
