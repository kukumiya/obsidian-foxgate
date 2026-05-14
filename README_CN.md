# FoxGate 🦊🚪

> 从任何地方访问你的 Obsidian vault —— 手机、平板、任意 MCP 客户端。
> 零成本。零运维。24/7 在线。

[English](./README.md) | 中文

一个部署在 Cloudflare Workers 上的轻量 MCP 服务器，让 AI（Claude、RikkaHub 等）通过 GitHub API 24/7 读写你的 Obsidian vault。

## 为什么需要它

本地 MCP 服务器在桌面端好用，但需要电脑保持在线：

- 出门 → 连接断开
- Tailscale 能解决，但占用安卓 VPN 通道
- Claude 手机 app 无法连接本地 MCP

FoxGate 把 MCP 服务器放到云端（Cloudflare Workers），通过 GitHub API 读写你的 vault。电脑可以关机，随时随地可用。

## 架构

```
手机 (Claude app / RikkaHub / 任意 MCP 客户端)
         │
         │ HTTPS (Streamable HTTP)
         ▼
Cloudflare Worker (your-domain.com/mcp)
         │
         │ GitHub REST API (token 认证)
         ▼
GitHub 私有仓库 (你的 vault)
         │
         │ Obsidian Git 插件 (自动 pull/push)
         ▼
电脑 / 手机 Obsidian (本地镜像)
         │
         ▼
任意支持 MCP 的前端 (可无限扩展)
```

## 特性

- **6 个 MCP 工具**：`obsidian_list`、`obsidian_read`、`obsidian_write`、`obsidian_append`、`obsidian_search`、`obsidian_delete`
- **Bearer token 认证**
- **无状态** —— 不需要数据库，不需要 Durable Objects，可在 Workers Free 计划运行
- **每次写入都是一次 git commit** —— 自带版本历史，误删可找回
- **自定义域名支持**

## 成本

| 项目 | 费用 |
|------|------|
| Cloudflare Workers Free | ¥0（每天 10 万次请求） |
| GitHub Free | ¥0（私有仓库无限） |
| **合计** | **¥0/月** |

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/Omnitopia/foxgate.git
cd foxgate
npm install
```

### 2. 配置密钥

需要 4 个密钥，逐个运行并粘贴对应值：

```bash
# GitHub 个人访问令牌（需要 repo 权限）
# 在 https://github.com/settings/tokens 生成
npx wrangler secret put GITHUB_TOKEN

# 你的 GitHub 用户名
npx wrangler secret put GITHUB_OWNER

# 你的 vault 仓库名
npx wrangler secret put GITHUB_REPO

# MCP 认证密码（自己随机生成一个）
# 例如：openssl rand -hex 32
npx wrangler secret put FOXGATE_TOKEN
```

> 第一次运行 `wrangler` 会弹浏览器让你登录 Cloudflare。

### 3. 部署

```bash
npm run deploy
```

测试：
```bash
curl https://foxgate.<你的账号>.workers.dev/health
# 应该返回：{"status":"ok","service":"FoxGate 🦊🚪","version":"1.0.0"}
```

### 4. 自定义域名（可选）

1. Cloudflare Dashboard → Workers & Pages → `foxgate`
2. Settings → Domains & Routes → Add → Custom Domain
3. 输入你的子域名（如 `foxgate.yourdomain.com`）
4. 等几分钟 DNS 生效

### 5. 连接 MCP 客户端

**RikkaHub（安卓）：**
- 传输类型：Streamable HTTP
- 地址：`https://你的域名/mcp?token=你的FOXGATE_TOKEN`

**Claude app（iOS/安卓）：**
1. 电脑上打开 **claude.ai**
2. Settings → Connectors → Add Custom Connector
3. 名称：`FoxGate`
4. URL：`https://你的域名/mcp?token=你的FOXGATE_TOKEN`
5. 配置会自动同步到手机

**Claude Desktop（通过 mcp-remote）：**
```json
{
  "mcpServers": {
    "foxgate": {
      "command": "npx",
      "args": ["mcp-remote@latest", "https://你的域名/mcp?token=你的FOXGATE_TOKEN"]
    }
  }
}
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `obsidian_list` | 列出 vault 中的文件和目录 |
| `obsidian_read` | 读取笔记内容 |
| `obsidian_write` | 创建/更新笔记 |
| `obsidian_append` | 追加内容到笔记末尾 |
| `obsidian_search` | 全文搜索笔记 |
| `obsidian_delete` | 删除笔记（需确认） |

## 前置条件

- GitHub 账号，vault 在私有仓库中（用 [Obsidian Git](https://github.com/denolehov/obsidian-git) 插件同步）
- Cloudflare 账号（免费）
- 电脑已安装 Node.js

## 常见问题

**Q：数据安全吗？**
vault 始终在你的 GitHub 私有仓库中。Worker 只通过你的个人 token 访问。Bearer token 防止未授权的 MCP 访问。

**Q：误删了怎么办？**
每次写入都是一次 git commit，可以随时通过 git 历史回滚。

**Q：除了 Claude 还能用什么？**
任何支持 Streamable HTTP 传输的远程 MCP 客户端都可以。

**Q：不买域名能用吗？**
可以。Cloudflare 会自动分配一个免费的 `*.workers.dev` 域名。

## 许可

MIT

## 关于
由 [Omnitopia](https://github.com/Omnitopia) 开发 - 全一的乌托邦
