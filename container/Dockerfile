# CQU 浏览器登录器镜像。用 buildx --platform=linux/amd64 构建(CF Containers 仅跑 amd64)。
# 注: 不在此处写 `FROM --platform=linux/amd64`(会触发 docker lint 警告), 平台靠构建时 --platform 指定。
FROM python:3.12-slim

# Chromium 渲染所需最小系统库集合(实测可在 basic 1 GiB 限制下构建并渲染真实登录页)。
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && patchright install chromium

COPY server.py cqu_login.py qg_proxy.py ./

EXPOSE 8080
CMD ["python", "server.py"]
