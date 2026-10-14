# Third-Party Notices

*English first, Portuguese (Português) below.*

## English

This extension is distributed under the MIT license (see `LICENSE`). It is a fork of
**Tootega Cockpit for Claude Code** (<https://github.com/HermesSilva/Cockpit>), Copyright (c) 2026
Tootega Pesquisa e Inovação, released under the MIT license; that copyright notice is kept in
`LICENSE`. It also includes and/or depends on third-party components, listed below with their
respective licenses. The dictionary files are **data** loaded at run time, not code linked into the
binary.

### Spelling dictionaries (bundled in `dict/`)

#### English — `dict/en.aff`, `dict/en.dic`
Derived from SCOWL (Spell Checker Oriented Word Lists) through the Hunspell `en_US` project —
<http://wordlist.sourceforge.net>.
Permissive BSD/MIT-style license. Full text in `dict/en.LICENSE.txt`.

#### Portuguese (Brazil) — `dict/pt-br.aff`, `dict/pt-br.dic`
VERO project — the LibreOffice spelling checker.
Author: Raimundo Santos Moura and the Brazilian community.
Copyright (C) 2006–2013.
Licensed under the **GNU LGPL v3** and the **Mozilla Public License (MPL)**, at your option.
Full text in `dict/pt-br.LICENSE.txt`.
<http://pt-br.libreoffice.org/projetos/projeto-vero-verificador-ortografico/>

### Run-time libraries

Bundled into `dist/` by esbuild:

- `hunspell-asm` (MIT): spelling engine in WebAssembly.
- `nspell` (MIT): auxiliary spell checker.
- `highlight.js` (BSD-3-Clause): syntax highlighting.
- `qrcode` (MIT): QR code generation.
- `ws` (MIT): WebSocket client (voice dictation).
- `react`, `react-dom` (MIT): the webview UI.

The full license of each package is in its directory under `node_modules/` in the source repository.

---

## Português

Esta extensão é distribuída sob a licença MIT (ver `LICENSE`). Ela é um fork do
**Tootega Cockpit for Claude Code** (<https://github.com/HermesSilva/Cockpit>), Copyright (c) 2026
Tootega Pesquisa e Inovação, licenciado sob MIT; esse aviso de copyright é mantido em `LICENSE`.
Ela também inclui e/ou depende de componentes de terceiros, listados abaixo com suas respectivas
licenças. Os arquivos de dicionário são **dados** carregados em tempo de execução, não código
ligado ao binário.

### Dicionários ortográficos (empacotados em `dict/`)

#### Inglês — `dict/en.aff`, `dict/en.dic`
Derivado do SCOWL (Spell Checker Oriented Word Lists) via projeto
`en_US` Hunspell — <http://wordlist.sourceforge.net>.
Licença permissiva estilo BSD/MIT. Texto completo em `dict/en.LICENSE.txt`.

#### Português (Brasil) — `dict/pt-br.aff`, `dict/pt-br.dic`
Projeto VERO — Verificador Ortográfico do LibreOffice.
Autor: Raimundo Santos Moura e comunidade brasileira.
Copyright (C) 2006–2013.
Licenciado sob **GNU LGPL v3** e **Mozilla Public License (MPL)**, à escolha.
Texto completo em `dict/pt-br.LICENSE.txt`.
<http://pt-br.libreoffice.org/projetos/projeto-vero-verificador-ortografico/>

### Bibliotecas em tempo de execução

Empacotadas no bundle (`dist/`) via esbuild:

- `hunspell-asm` (MIT) — motor de verificação ortográfica em WebAssembly.
- `nspell` (MIT) — verificador ortográfico auxiliar.
- `highlight.js` (BSD-3-Clause) — realce de sintaxe.
- `qrcode` (MIT) — geração de QR Code.
- `ws` (MIT) — cliente WebSocket (ditado por voz).
- `react`, `react-dom` (MIT) — UI do webview.

As licenças completas de cada pacote estão nos respectivos diretórios em
`node_modules/` no repositório de origem.
