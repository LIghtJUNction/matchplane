# MatchPlane HTTPS 部署

签入的 Nginx 配置为打包的 Web 客户端提供服务，代理
`/api/`下的市场API，并代理下的公共支付操作
`/payments-api/`。付款管理员路线故意不可用
公众听众。

`matchplane-bootstrap.conf` 提供第一个 ACME 所需的 HTTP webroot
挑战。 Certbot颁发`matx.tech`证书后，将其替换为
`matchplane.conf`。

存储库配置假设 `matx.tech` 的 DNS 指向主机，并且
Certbot 将证书存储在
`/etc/letsencrypt/live/matx.tech/`。续订必须保持自动化；服务器
安装一个运行 `nginx -t` 的 Certbot 部署钩子，并在运行后重新加载 Nginx
续订成功。
