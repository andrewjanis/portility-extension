# Portility Extension

## Getting Started

### One-time setup

**1. Install Git** (if you don't have it)
- Download from https://git-scm.com/downloads
- During install, accept all defaults

**2. Configure your identity**

Open a terminal (Git Bash, Terminal, or Command Prompt) and run:
```bash
git config --global user.name "your-github-username"
git config --global user.email "your-github-username@users.noreply.github.com"
```
Replace `your-github-username` with your actual GitHub username.

**3. Clone the repo**
```bash
cd ~/dev
git clone https://github.com/andrewjanis/portility-extension.git
cd portility-extension
```
This creates a local copy of the code on your machine.

---

### Daily workflow

**Pull the latest changes** (do this before starting work):
```bash
git pull
```

**See what you've changed:**
```bash
git status
```

**Save your changes (commit + push):**
```bash
git add -A
git commit -m "Brief description of what you changed"
git push
```

---

### If you get a merge conflict

This happens when two people edit the same lines. Git will tell you which files conflict. Open them, look for the `<<<<<<<` markers, choose which version to keep, then:
```bash
git add -A
git commit -m "Resolve merge conflict"
git push
```

---

### Loading the extension in Chrome (for testing)

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked**
4. Select the `src/` folder inside your cloned repo

---

### Tips

- **Always pull before you push** — avoids conflicts
- **Commit often** with small, descriptive messages
- **Don't edit the same file at the same time** as someone else if possible — coordinate first
- If something goes wrong, `git status` and `git log` are your friends