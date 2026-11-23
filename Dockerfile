# Linux ARM64 build+test env for asmzod (run under colima/docker on Apple Silicon)
FROM oven/bun:1-debian
RUN apt-get update -qq && apt-get install -y -qq clang make file gdb && rm -rf /var/lib/apt/lists/*
WORKDIR /src
CMD ["bash", "-c", "make -C asm clean && make -C asm && bun test"]
