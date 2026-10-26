# BASE_IMAGE is pinned by image.json and supplied by Tao's preparation command.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG TAO_IMAGE_VERSION
LABEL org.opencontainers.image.title="Tao tool runtime" \
      org.opencontainers.image.version="${TAO_IMAGE_VERSION}" \
      org.opencontainers.image.description="Node, Python and common command-line tools for Tao's Linux sandbox"
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git jq ripgrep unzip zip \
       python3 python3-pip python3-venv build-essential \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && mkdir -p /opt/tao \
    && dpkg-query -W > /opt/tao/os-packages.tsv \
    && rm -rf /var/lib/apt/lists/*
ENV LANG=C.UTF-8 \
    PYTHONIOENCODING=utf-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp \
    TMPDIR=/tmp
COPY smoke.mjs /opt/tao/smoke.mjs
USER 1000:1000
WORKDIR /workspace
CMD ["node", "/opt/tao/smoke.mjs"]
