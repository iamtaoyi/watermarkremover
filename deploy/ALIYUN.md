# 阿里云部署指南（ClipFlow 全自动视频去字幕）

目标：把这个网站部署到阿里云，得到一个**公网地址**，从而满足去字幕接口的硬性要求——接口在公网侧，必须能匿名拉取本服务上的源文件。

```
公网用户 ──▶ 阿里云 ECS（公网 IP / 域名）
                │
                ├── Nginx  :80/:443      ← 对外只开这两个端口
                │     └── 反代到 127.0.0.1:8787
                └── systemd: clipflow    ← node server.mjs（零依赖，无需 npm install）
                        └── 数据目录 /opt/clipflow/data（上传文件、产物，12 小时自动清理）
```

应用是**零第三方依赖**的纯 Node 项目，所以部署只需：装 Node → 拷贝文件 → 起服务。

---

## 一、买哪台机器

| 方案 | 适用 | 建议配置 |
| --- | --- | --- |
| **轻量应用服务器**（推荐，便宜省事） | 内部小规模使用 | 2 核 2 GB、系统盘 40 GB、带宽 3–5 Mbps、**Ubuntu 22.04** |
| ECS 云服务器 | 需要更灵活的网络/安全组 | ecs.c7 或 ecs.u1、2 核 2 GB、Ubuntu 22.04、按量或包年包月 |
| 函数计算 / SAE | **不建议** | 本应用有本地磁盘状态（上传文件、任务），容器化改造后才合适 |

选型要点：

- **地域**：离使用者近（例如团队在华东就选华东 1/2）。
- **系统盘**：视频文件大，建议 ≥40 GB 并开启自动快照。
- **带宽**：上传下载都走这台机器。3 Mbps ≈ 375 KB/s，传 1 GB 视频约 45 分钟——带宽是这个方案的真正瓶颈，建议按量计费或更高固定带宽。
- **公网 IP**：买的时候勾选"分配公网 IPv4 地址"。

---

## 二、安全组 / 防火墙

在阿里云控制台的**安全组入方向**放行：

| 端口 | 用途 | 说明 |
| --- | --- | --- |
| 22 | SSH 运维 | 强烈建议把来源限制为你自己的出口 IP |
| 80 | HTTP | 公开访问（用 Nginx 时） |
| 443 | HTTPS | 配好证书后 |
| 8787 | 应用直连 | **不建议对公网开放**；用 Nginx 时不要放行 |

如果图省事、先不装 Nginx，也可以直接放行 8787 用 `http://公网IP:8787` 访问（功能一样，但没有 HTTPS）。

---

## 三、把代码传上去

```bash
# 在你本地（Mac）的项目目录执行；data/ 与 deploy 目录都不用传 data
rsync -av --exclude 'data' --exclude '.git' \
  ./server.mjs ./pipeline.mjs ./package.json ./README.md ./public ./deploy \
  root@<服务器公网IP>:/root/clipflow-src/
```

也可以先压缩再上传：

```bash
tar --exclude data -czf clipflow.tar.gz server.mjs pipeline.mjs package.json README.md public deploy
scp clipflow.tar.gz root@<服务器公网IP>:/root/ && ssh root@<服务器公网IP> 'mkdir -p /root/clipflow-src && tar -xzf /root/clipflow.tar.gz -C /root/clipflow-src'
```

---

## 四、一条命令完成安装

```bash
ssh root@<服务器公网IP>
cd /root/clipflow-src
sudo ACCESS_TOKEN='换成你的强口令' ./deploy/install.sh
```

脚本会：装好 Node 20（从国内镜像）→ 创建 `clipflow` 系统用户 → 拷贝到 `/opt/clipflow` → 生成 `/opt/clipflow/clipflow.env`（0600）→ 注册并启动 systemd 服务 → 打印公网地址。

常用参数：

```bash
APP_DIR=/data/clipflow                 # 换安装目录（数据盘更合适）
PORT=8787                              # 应用端口
NODE_MIRROR=https://npmmirror.com/mirrors/node
```

---

## 五、填好去字幕接口配置（关键一步）

```bash
vim /opt/clipflow/clipflow.env
```

```ini
PORT=8787
# 直接对外暴露用 0.0.0.0；前置 Nginx 后可改成 127.0.0.1
HOST=0.0.0.0
DATA_DIR=/opt/clipflow/data
ACCESS_TOKEN=你的登录口令

# 去字幕接口
AMK_API_KEY=你的接口密钥
# 必须是「公网能匿名访问到本服务」的地址：
#   用域名        → https://video.example.com
#   只用 IP+端口  → http://<服务器公网IP>:8787
PUBLIC_BASE_URL=http://<服务器公网IP>:8787

UPLOAD_TTL_HOURS=12
```

```bash
systemctl restart clipflow && journalctl -u clipflow -n 20 --no-pager
```

启动日志里应看到：

```
去字幕接口 https://mediakit.cn-beijing.volces.com/api/v1/tools/erase-video-subtitle-pro
             密钥与公网入口均已配置，可以提交任务
```

**如果 `PUBLIC_BASE_URL` 没配或填了内网地址**，提交任务时会返回 `503`/去字幕接口会报 `UrlDownloadFail`——因为云端拉不到你的文件。这是最容易踩的坑。

---

## 六、域名与 HTTPS（可选但建议）

1. **域名解析**：在阿里云 DNS 把 `video.example.com` 的 A 记录指向服务器公网 IP。
2. **ICP 备案**：服务器在**中国大陆**地域时，用域名对外提供 Web 服务需要备案（阿里云控制台有备案入口，通常几天到两周）。只想先用起来，可以先用 `http://公网IP:8787` 免备案访问。
3. **证书**：阿里云"数字证书管理服务"可申请免费 DV 证书，下载 Nginx 版后放到服务器；或用 certbot：
   ```bash
   apt-get install -y certbot python3-certbot-nginx
   certbot --nginx -d video.example.com
   ```
4. **Nginx 反代**：
   ```bash
   apt-get install -y nginx
   cp /opt/clipflow/deploy/nginx-clipflow.conf.example /etc/nginx/conf.d/clipflow.conf
   # 改 server_name 与证书路径后：
   nginx -t && systemctl reload nginx
   ```
   该配置已包含三个必须项：`client_max_body_size 0`（大文件不被 413 挡下）、`proxy_request_buffering off`（保持流式上传）、`proxy_force_ranges on`（预览拖动进度条依赖 Range）。
5. 配好后把 `PUBLIC_BASE_URL` 改成 `https://video.example.com` 并重启服务。

---

## 七、部署验证清单

```bash
# 1. 服务在跑
systemctl is-active clipflow

# 2. 本机接口通
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/

# 3. 公网可达（在你本地电脑执行）
curl -s -o /dev/null -w '%{http_code}\n' http://<公网IP>:8787/

# 4. 能力 URL 能被匿名拉取（这是去字幕接口要做的事，必须 200）
curl -s -o /dev/null -w '%{http_code}\n' http://<公网IP>:8787/f/<某个文件ID>   # 登录上传后可拿到

# 5. 未登录访问业务接口应 401
curl -s -o /dev/null -w '%{http_code}\n' http://<公网IP>:8787/api/config       # 期望 401
```

浏览器端完整走一遍：登录 → 上传视频（秒传可再传一次验证）→ 预览 → 开始全自动去字幕 → 进度 → 结果预览 → 下载。

---

## 八、日常运维

| 事项 | 命令 |
| --- | --- |
| 查看日志 | `journalctl -u clipflow -f` |
| 重启 / 停止 | `systemctl restart clipflow` / `systemctl stop clipflow` |
| 改配置 | 改 `/opt/clipflow/clipflow.env` 后 `systemctl restart clipflow` |
| 升级代码 | 本地重新 rsync → 再跑一次 `./deploy/install.sh`（会保留 `clipflow.env` 与 `data/`） |
| 磁盘占用 | `du -sh /opt/clipflow/data`（源文件与产物 12 小时自动清理，`UPLOAD_TTL_HOURS` 可调） |
| 备份 | 只需备份 `/opt/clipflow/data`（含 `db.json`、上传文件、产物）；建议开 ECS 自动快照 |

---

## 九、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 公网打不开，本机 curl 正常 | 安全组没放行端口；或应用 `HOST` 绑在 127.0.0.1 而你直接访问了 8787（用 Nginx 时这是预期的） |
| 上传大视频报 413 | Nginx 的 `client_max_body_size` 没设为 0 |
| 预览视频拖不动进度条 | 代理层没透传 Range（本仓库的 nginx 示例已含 `proxy_force_ranges on`） |
| 点「开始全自动去字幕」提示服务未就绪 | `clipflow.env` 里 `AMK_API_KEY` 或 `PUBLIC_BASE_URL` 没填；改完重启服务 |
| 任务失败且提示接口拉不到源视频 | `PUBLIC_BASE_URL` 填成了内网地址，或该地址公网访问不了（可用第七节的第 4 步自检） |
| `node: command not found` | 用 `/usr/local/bin/node -v` 确认；或重跑 install.sh 的 Node 安装步骤 |
| 磁盘被上传文件占满 | 调小 `UPLOAD_TTL_HOURS`，或给数据目录单独挂数据盘 |

---

## 十、安全建议

1. `ACCESS_TOKEN` 用足够复杂的口令；公网务必上 HTTPS（否则口令与视频都会明文传输）。
2. 安全组只放行 22/80/443，SSH 来源限制到自己的 IP。
3. 本服务默认给所有登录用户共享同一份文件空间，**面向公网时建议加一层来源限制**（Nginx `allow/deny` 或阿里云 WAF），后续再考虑按用户隔离。
4. 上传内容是别人的视频，注意内部合规；`UPLOAD_TTL_HOURS=12` 是最后一道兜底。
5. 开启 ECS 自动快照，避免误删数据目录。
