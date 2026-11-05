# Entrar no servidor de um amigo

Alguém do grupo hospeda o servidor (aba **Hospedar**). Você não instala nada além do Jay-C: só precisa do endereço do servidor e do nome de uma sala.

## 1. Pegue o endereço

Peça a quem hospeda o endereço do servidor e o nome da sala. O endereço é parecido com `192.168.1.50:3000`.

- **Mesma rede** (em casa, LAN party): é só isso.
- **Pela internet:** antes, entre na mesma rede do ZeroTier ou do Radmin VPN de quem hospeda e use o endereço que essa pessoa passar nessa rede.

![Amigos se conectando ao PC do servidor](/assets/setup/step4_address.svg)

## 2. Conecte o app

Abra **Configurações › Servidor**, coloque o endereço com a porta e clique em **Testar**. Quando aparecer "Conectou", digite o nome da sala no lobby e entre: todo mundo que entrar com o mesmo nome de sala cai na mesma chamada.

![Configurações › Servidor com um endereço funcionando](/assets/setup/step5_connect.png)

## Se não funcionar

- **"Sem resposta" ou "Não conectou":** confira o endereço com quem hospeda. Talvez o servidor não esteja rodando, ou o firewall esteja bloqueando a porta `3000`.
- **Você entra, mas não vê nem ouve ninguém:** o firewall de quem hospeda está bloqueando a porta `40000` (passo 3 da aba **Hospedar**).
