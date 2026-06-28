# Tabulon 


## Installation

### Prérequis

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Tauri CLI
cargo install tauri-cli --version "^2"

# Node + dépendances racine
npm install

# Dépendances frontend
npm --prefix app install

# Parser PJN (si pjn-parser/*.jison existe)
npm run build:parser
```

### Démarrage dev

```bash
npm run dev
# ou
cargo tauri dev
```

### Build production

```bash
npm run build
# ou
cargo tauri build
```

---

