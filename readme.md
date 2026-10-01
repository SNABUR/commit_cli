# Commit Agent 🚀

Agente multiplataforma (Windows y Linux) para recopilar automáticamente mensajes de commit locales y almacenarlos en **Cloudflare D1** a través de un Worker, sin requerir acceso ni tokens de GitHub.

## 🌐 Endpoint del Worker

Configura tu propio Cloudflare Worker para recibir los eventos:
- **Ejemplo Custom Domain:** `https://commits.tu-dominio.com/v1/commits`
- **Ejemplo Worker URL:** `https://commit-agent-worker.<tu-subdominio>.workers.dev/v1/commits`
- **Health Check:** `https://commits.tu-dominio.com/health`

---

## 🛠️ Instalación y Uso

### 1. En Windows o Linux (VPS)

Solo requieres tener **Node.js (v18+)** y **Git**.

Clona o descarga este repositorio:
```bash
git clone <url-del-repo>
cd cli_github
```

Ejecuta la inicialización global:
```bash
node cli/bin/commit-agent.js init
```
*(Opcional: puedes especificar endpoint personalizado con `--endpoint <url>` o clave secreta `--secret <key>`)*.

### 2. ¿Cómo funciona en el día a día?

No tienes que hacer nada más. Trabaja con Git como siempre:
```bash
git add .
git commit -m "feat: nueva funcionalidad"
```

El Git hook global (`commit-msg`) intercepta la primera línea del mensaje de commit, identifica el repositorio local, la rama y el autor, y lo despacha de forma segura a Cloudflare D1.

---

## 🛡️ Principio Fail-Open (Resiliencia)

- Si te quedas sin Internet o Cloudflare está temporalmente inaccesible, **tu `git commit` jamás se bloquea**.
- El agente guarda el commit en una cola local (`~/.commit-agent/queue.json`) y lo envía automáticamente cuando haya conexión.
- Puedes forzar la sincronización de la cola manualmente con:
```bash
node cli/bin/commit-agent.js sync
```
- Verificar el estado actual:
```bash
node cli/bin/commit-agent.js status
```

---

## 📊 Consultar los Commits en D1

### Vía HTTP (API)
```bash
curl https://commits.tu-dominio.com/v1/commits
```
Filtrar por repositorio:
```bash
curl "https://commits.tu-dominio.com/v1/commits?repo=mi-proyecto&limit=20"
```

### Vía Wrangler CLI
```bash
pnpm dlx wrangler d1 execute commit-agent-db --remote --command="SELECT * FROM commit_messages ORDER BY created_at DESC LIMIT 10;"
```
