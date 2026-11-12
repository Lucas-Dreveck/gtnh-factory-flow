# Self-host (privado)

Instância privada para um grupo pequeno: contas só por convite, sem telemetria,
sem serviços externos. Acesse por Tailscale (ou por um proxy HTTPS seu).
**Não exponha a porta na internet.**

## 1. Dataset (uma vez, ~105 MB)
```bash
node tools/mirror-dataset.mjs      # grava em public/datasets/gtnh
```

## 2a. Docker Compose (recomendado)
```bash
docker compose up -d --build
docker compose logs planner        # mostra o código de convite ADMIN (uso único)
```
O app escuta só em `127.0.0.1:3000`. Para os amigos acessarem pelo Tailscale com HTTPS:
```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
```
Depois coloque o nome `*.ts.net` em `GTNH_ALLOWED_HOSTS` no `docker-compose.yml`.

## 2b. Sem Docker (Node 24)
```bash
npm ci && npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public          # inclui public/datasets/gtnh
cd .next/standalone
GTNH_DATA_DIR=/srv/gtnh-planner/var HOSTNAME=127.0.0.1 PORT=3000 GTNH_COOKIE_SECURE=1 \
  node --disable-warning=ExperimentalWarning server.js
```
Ou gere um pacote pronto (precisa de Docker só para compilar): `bash tools/release/package.sh`
→ `dist/gtnh-planner.tar.gz` (extraia e rode `node server.js`).

## 3. Primeira conta e convites
Abra `/login` → "criar conta" com o código ADMIN do log. Convites para outras pessoas: `/admin`.

## Variáveis
| Variável | Padrão | Para quê |
|---|---|---|
| `GTNH_DATA_DIR` | `./var` | SQLite com contas, planos, histórico e `backups/` |
| `GTNH_COOKIE_SECURE` | auto | `1` atrás de HTTPS; `0` em http puro |
| `GTNH_ALLOWED_HOSTS` | (qualquer) | lista de hosts aceitos (proteção contra DNS rebinding) |
| `GTNH_TRUST_PROXY` | `0` | `cloudflare` atrás de Cloudflare Tunnel; `1` atrás de proxy seu que sobrescreve `X-Forwarded-For` |
| `GTNH_BACKUP_HOURS` / `GTNH_BACKUP_KEEP` | `24` / `14` | cópias consistentes do banco |
| `GTNH_PLAN_MAX_BYTES` | 32 MB | maior plano aceito |

## Atualizar e backup
- Atualizar: `git pull && docker compose up -d --build` (os dados ficam no volume `planner-data`).
- Backup: copie `backups/` do volume para fora do servidor. Não copie `planner.sqlite` com o app rodando.
