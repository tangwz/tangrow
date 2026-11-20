# Tangrow 授权服务

服务需要 Node.js 22，提供 `POST /v1/activate`、`POST /v1/renew` 和 `POST /v1/release`。飞书多维表格保存许可和设备记录，服务在进程内维护每个许可的锁、请求计数和飞书令牌。部署和升级时始终只运行一个实例，使用停止旧进程后再启动新进程的方式切换。

在仓库根目录安装锁定的依赖并检查服务。

```sh
npm ci --include=dev
npm run server:typecheck
npm run server:test
```

## 飞书与服务配置

1. 按[购买与激活规格](../docs/PURCHASE-ACTIVATION.md#飞书多维表格)建立私有多维表格及许可、设备两张表。许可编号、兑换码摘要、设备摘要和订单号使用文本字段。设备上限使用数字，首次激活和最近续期使用日期。预建文档中的状态、平台和渠道选项。每个许可编号、兑换码摘要，以及同一许可下的设备摘要都应唯一。售后使用状态字段撤销或释放，保留原行。
2. 创建并发布自建应用，开通多维表格读写权限。通过「添加文档应用」仅授予这一个多维表格的编辑权限，确认应用可读取两张表。记录 App ID、App Secret、Base Token（多维表格的 `app_token`）及两张表的 ID。[飞书多维表格权限说明](https://open.feishu.cn/document/docs/bitable-v1/faq?lang=zh-CN)
3. 把下方配置填到仓库外的 JSON 文件中，服务账号持有，权限为 `0600`。用 `TANGROW_LICENSE_CONFIG` 指定绝对路径。也可通过受控运行环境中的 `TANGROW_LICENSE_SETTINGS` 直接提供同一份 JSON，二者选其一。

```json
{
  "feishu": {
    "appId": "APP_ID",
    "appSecret": "APP_SECRET",
    "baseToken": "BASE_TOKEN",
    "licenseTableId": "LICENSE_TABLE_ID",
    "deviceTableId": "DEVICE_TABLE_ID"
  },
  "signing": {
    "kid": "prod-1",
    "seedHex": "REPLACE_WITH_64_LOWERCASE_HEX_CHARACTERS"
  },
  "listen": {
    "host": "127.0.0.1",
    "port": 8787,
    "trustLoopbackProxy": true
  }
}
```

默认列名见 [fields.json](fields.json)。可在 `feishu.fields.license` 覆盖 `id`、`codeDigest`、`status`、`deviceLimit`，在 `feishu.fields.device` 覆盖 `licenseId`、`digest`、`platform`、`firstActivatedAt`、`lastRenewedAt`、`status`。若使用自定义列名，导入制卡 CSV 时要映射到实际列。服务按规格读取和写入原有中文状态值。

续期请求可附带平台。已有设备行保留原平台；行缺失且名额有空时，服务器用请求平台补建；名额已满则签发 `released`。旧客户端未提供补建所需的平台时返回 `400 bad_request`，用户可用原兑换码重新激活。

## 生成密钥与轮换

在可信机器的仓库根目录生成密钥。以下脚本把 32 字节私钥种子写入权限为 `0600` 的新文件，终端输出可分发的公钥条目。将该文件的内容作为配置的 `signing` 对象，私钥只保存在 ECS 配置和离线备份里。

```sh
TANGROW_KEY_FILE=/secure/tangrow-prod-1.json TANGROW_KEY_ID=prod-1 node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import nacl from 'tweetnacl';

const seed = randomBytes(32);
const kid = process.env.TANGROW_KEY_ID;
const key = Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey).toString('base64url');
writeFileSync(process.env.TANGROW_KEY_FILE, JSON.stringify({ kid, seedHex: seed.toString('hex') }) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(JSON.stringify({ [kid]: key }));
JS
```

把生产公钥与服务 HTTPS 地址配置进插件的 [access.ts](../src/access.ts)，发布前核对 `kid` 和实际签名密钥对应。常规轮换先发布同时内置新旧公钥的插件，待用户升级后再更换服务器的 `kid` 和 `seedHex`，在 `signing.previousPublicKeys` 保留旧 `kid` 到原始 32 字节 base64url 公钥的映射。旧签名仍用于验证续期和解绑，新返回的租约全部用新密钥签发。

轮换 30 天后，原有租约已超过最长离线有效期。继续保留旧验证公钥能让长期离线用户用过期租约续期。移除旧公钥后，这些用户需要再次输入兑换码。私钥泄露时立即替换签名配置并移除泄露密钥对应的验证公钥，同时发布移除该公钥的插件。

## ECS、systemd 和 HTTPS

确定 ECS 地域后准备域名与证书。域名解析到中国内地 ECS 并开放 Web API 前先完成 ICP 备案。香港和海外节点无需办理工信部 ICP 备案。[阿里云备案说明](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)

将仓库部署到 `/opt/tangrow`，安装 Node.js 22 并按上面的命令准备依赖。创建无登录权限的 `tangrow-license` 系统账号，把配置放在 `/etc/tangrow/license.json`，保证该账号能读取配置及其父目录。把以下示例写入 `/etc/systemd/system/tangrow-license.service`，按实际安装位置调整 Node 的绝对路径。

```ini
[Unit]
Description=Tangrow license service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=tangrow-license
Group=tangrow-license
WorkingDirectory=/opt/tangrow
Environment=TANGROW_LICENSE_CONFIG=/etc/tangrow/license.json
ExecStart=/usr/bin/node --import tsx server/index.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tangrow-license.service
sudo systemctl status tangrow-license.service
```

nginx 监听 80/443 并终止 TLS，授权服务只绑定回环地址。将示例域名与证书路径替换为实际值，证书私钥权限设为 `0600`。nginx 覆盖 `X-Real-IP`，服务只从回环代理读取该头。安全组只开放需要的端口，8787 保持本机访问。

```nginx
server {
    listen 80;
    server_name license.example.com;
    access_log off;
    error_log /dev/null crit;
    return 308 https://license.example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name license.example.com;
    ssl_certificate /etc/nginx/tls/license.fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/license.key;

    access_log off;
    error_log /dev/null crit;
    client_max_body_size 4k;
    client_header_timeout 10s;
    client_body_timeout 10s;
    send_timeout 10s;

    location ~ ^/v1/(activate|renew|release)$ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_connect_timeout 10s;
        proxy_read_timeout 10s;
        proxy_send_timeout 10s;
        proxy_next_upstream off;
        error_page 413 = @invalid_body;
    }

    location @invalid_body {
        default_type application/json;
        return 400 '{"error":"bad_request"}';
    }

    location / { return 404; }
}
```

```sh
sudo nginx -t
sudo systemctl reload nginx
sudo journalctl -u tangrow-license.service
```

首发前用测试表经 HTTPS 联调激活、续期、解绑、撤销和第 4 台设备的拒绝响应，再重启服务确认原绑定可续期。检查应用日志的每条请求记录仅含许可编号前 8 位、接口名、结果和耗时。随后在桌面端、iOS 和 Android 检查生产公钥配置及 Obsidian 的实际网络调用。

## 制卡与换码

在本机的仓库根目录运行。输出目录须为新目录，其上级目录须已存在。目录权限为 `0700`，两个输出文件权限为 `0600`。

```sh
npm run license:cards -- --count 10 --channel xiaohongshu --batch batch-001 --out /secure/batch-001
npm run license:cards -- --replace 0123456789abcdef0123456789abcdef --out /secure/replacement
```

`--channel` 接受 `xiaohongshu` 或 `douyin`。新批次的 `feishu-import.csv` 导入许可表，`cards.txt` 导入店铺卡密库，确认导入后删除本地明文文件。换码输出的 CSV 仅包含许可编号、新摘要和新尾号。根据许可编号找到原行，更新摘要和尾号并保留原行其余字段及设备绑定。
