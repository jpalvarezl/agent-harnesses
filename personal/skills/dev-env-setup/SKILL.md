---
name: dev-env-setup
description: Set up a complete developer shell environment with fish, starship, nvm, fisher plugins, lsd, bat, and Nerd Fonts. Works on macOS, Linux, and WSL+Windows. Use when setting up a new machine or reproducing the dev environment.
---

# Dev Environment Setup

Interactive setup skill. Detect the OS first, then follow the relevant section.

## Step 0 — Detect Environment

```bash
uname -s          # Darwin = macOS, Linux = Linux/WSL
cat /proc/version 2>/dev/null | grep -qi microsoft && echo "WSL" || echo "Native"
```

## Step 1 — Install Core Tools

### macOS
```bash
brew install fish lsd bat fzf starship
```

### Ubuntu / Debian / WSL
```bash
sudo apt update && sudo apt install -y fish
# lsd, bat, fzf, starship — install via latest GitHub releases or:
#   lsd:      https://github.com/lsd-rs/lsd/releases
#   bat:      sudo apt install -y bat  (binary is "batcat", symlink or alias needed)
#   fzf:      https://github.com/junegunn/fzf/releases
#   starship: curl -sS https://starship.rs/install.sh | sh
```

### Windows (PowerShell, for WSL companion setup)
```powershell
winget install lsd-rs.lsd
winget install sharkdp.bat
winget install Starship.Starship
```

## Step 2 — Fisher (Fish Plugin Manager)

```fish
curl -sL https://raw.githubusercontent.com/jorgebucaran/fisher/main/functions/fisher.fish | source && fisher install jorgebucaran/fisher
```

## Step 3 — Fisher Plugins

```fish
fisher install jethrokuan/z
fisher install PatrickF1/fzf.fish
fisher install jorgebucaran/autopair.fish
fisher install nickeb96/puffer-fish
fisher install PatrickF1/colored_man_pages.fish
fisher install edc/bass
fisher install jorgebucaran/nvm.fish
```

### Puffer-fish patch (Fish < 3.8.0)

Puffer-fish uses `commandline --search-field` which was added in Fish 3.8.0. On older versions, pressing `.`, `!`, `$`, or `*` throws errors. **After installing or updating puffer-fish**, apply this patch:

```bash
for f in ~/.config/fish/functions/_puffer_fish_expand_*.fish; do
    sed -i 's/--search-field >\/dev\/null/--search-field 2>\/dev\/null/g' "$f"
done
```

This redirects stderr instead of stdout so the unsupported flag fails silently. **This patch must be re-applied after every `fisher update nickeb96/puffer-fish`.** Skip this step if running Fish 3.8.0+.

## Step 4 — Fish Config

Write to `~/.config/fish/config.fish`:

```fish
# ─── Abbreviations (expand inline — better than aliases) ──
abbr -a ls  "lsd"
abbr -a ll  "lsd -la"
abbr -a lt  "lsd --tree"
abbr -a la  "lsd -a"

# On Ubuntu/WSL bat is "batcat"; on macOS/Windows it's "bat"
# Adjust accordingly:
abbr -a cat "batcat --paging=never"   # Ubuntu/WSL
abbr -a bat "batcat"                  # Ubuntu/WSL
# abbr -a cat "bat --paging=never"    # macOS
# abbr -a bat "bat"                   # macOS

# ─── PATH ─────────────────────────────────────────────────
fish_add_path ~/.local/bin

# ─── NVM (Node Version Manager) ──────────────────────────
set -gx nvm_default_version lts
nvm use $nvm_default_version >/dev/null 2>&1

# ─── Starship prompt ─────────────────────────────────────
starship init fish | source
```

## Step 5 — Shift+Enter for Newline (WSL/Windows Terminal only)

Create `~/.config/fish/conf.d/shift_enter.fish`:

```fish
bind \e\[13\;2u 'commandline -i \n'
```

And add this action to Windows Terminal `settings.json` → `actions`:

```json
{
    "command": { "action": "sendInput", "input": "\u001b[13;2u" },
    "keys": "shift+enter"
}
```

## Step 6 — Starship Config & Color Theme

**Before writing the starship config, ask the user which color theme they want.** Present these options:

| # | Theme | Description |
|---|---|---|
| 1 | **Gruvbox Dark** (default) | Warm retro palette — earthy greens, oranges, yellows |
| 2 | **Dracula** | Purple/pink/cyan vampire aesthetic |
| 3 | **Nord** | Arctic cool blues and teals |
| 4 | **Catppuccin Mocha** | Warm dark pastels, easy on the eyes |
| 5 | **Catppuccin Frappé** | Medium dark pastels |
| 6 | **Solarized Dark** | Classic Ethan Schoonover dark palette |
| 7 | **Tokyo Night** | Deep blue-purple with neon accents |
| 8 | **One Dark** | Atom editor inspired |
| 9 | **Gruvbox Light** | Light version of Gruvbox for bright environments |
| 10 | **Solarized Light** | Classic light theme |

Once the user picks a theme:

1. Generate a `~/.config/starship.toml` using the chosen palette for all segment colors (bg/fg). Use [references/starship.toml](references/starship.toml) as the structural template — keep the same format/layout/segments but swap all color values to match the chosen theme.
2. Generate a matching Windows Terminal color scheme (if WSL) using the theme's 16-color ANSI palette. Use [references/gruvbox-terminal-scheme.json](references/gruvbox-terminal-scheme.json) as the structural template.
3. Update the `colorScheme` name in Windows Terminal `profiles.defaults` to match.

If the user doesn't express a preference, default to **Gruvbox Dark**.

## Step 7 — JetBrainsMono Nerd Font

### macOS
```bash
brew install --cask font-jetbrains-mono-nerd-font
```

### Windows (from WSL or PowerShell)
Download from https://github.com/ryanoasis/nerd-fonts/releases/latest/download/JetBrainsMono.zip, extract, and install system-wide (right-click → Install for all users, or use Shell.Application COM).

## Step 8 — Windows Terminal Settings (WSL only)

In Windows Terminal `settings.json`:

1. Set font for all profiles and apply the user's chosen color scheme:
```json
"profiles": {
    "defaults": {
        "font": { "face": "JetBrainsMono Nerd Font", "size": 11 },
        "colorScheme": "<chosen theme name>"
    }
}
```

2. Set fish as WSL default:
```json
{ "commandline": "wsl.exe -d <DISTRO> -- /usr/bin/fish" }
```

3. Add the generated color scheme to the `schemes` array. Use the same palette chosen in Step 6.

## Step 9 — PowerShell Profile (Windows only)

Write to both PS5 and PS7 profiles (`$PROFILE`):

```powershell
Invoke-Expression (&starship init powershell)

Set-Alias -Name cat -Value bat -Option AllScope -Force -ErrorAction SilentlyContinue
function ls  { lsd @args }
function ll  { lsd -la @args }
function lt  { lsd --tree @args }
function la  { lsd -a @args }
```

## Step 10 — Set Fish as Default Shell

### macOS / Native Linux
```bash
echo /usr/local/bin/fish | sudo tee -a /etc/shells   # macOS (brew path)
chsh -s /usr/local/bin/fish                           # macOS
# or
chsh -s /usr/bin/fish                                 # Linux
```

### WSL
Set via Windows Terminal profile `commandline` (Step 8) since `chsh` may require a password.

## Verification

```fish
fish --version
fisher list
starship --version
node --version
nvm list
lsd --version
bat --version   # or batcat --version
fzf --version
pi --version
```
