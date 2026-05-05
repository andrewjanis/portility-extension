# Portility Extension

## Versions

| Branch | Version | Description |
|--------|---------|-------------|
| `main` | v1.5.0 | Latest — dynamic selectors, upload detection, Drive integration, settings |
| `stable/v1.3.1` | v1.3.1 | Stable release — text extraction only, no Drive/upload features |

---

## Tester Setup Guide

### Step 1: Install Git

If you don't already have Git installed:

1. Go to https://git-scm.com/downloads
2. Download the installer for your operating system (Windows, Mac, or Linux)
3. Run the installer — accept all default settings
4. When it finishes, close and reopen your terminal

To verify it installed, open a terminal and run:
```bash
git --version
```
You should see something like `git version 2.44.0`.

---

### Step 2: Create a GitHub account (if you don't have one)

1. Go to https://github.com/join
2. Sign up with your email
3. Tell Andrew your GitHub username so he can add you as a collaborator

---

### Step 3: Configure Git with your identity

Open a terminal (Git Bash on Windows, Terminal on Mac) and run these two commands. Replace the placeholder text with your actual GitHub username:

```bash
git config --global user.name "your-github-username"
git config --global user.email "your-github-username@users.noreply.github.com"
```

For example, if your GitHub username is `janedoe`:
```bash
git config --global user.name "janedoe"
git config --global user.email "janedoe@users.noreply.github.com"
```

This only needs to be done once.

---

### Step 4: Clone the repo

Choose a location on your computer for the code. We recommend a `dev` folder in your home directory:

```bash
mkdir -p ~/dev
cd ~/dev
git clone https://github.com/andrewjanis/portility-extension.git
cd portility-extension
```

This downloads all the code to `~/dev/portility-extension` on your machine.

---

### Step 5: Choose a version

**To test the latest version (v1.5.0):**
```bash
git checkout main
```

**To test the stable version (v1.3.1):**
```bash
git checkout stable/v1.3.1
```

You can switch between versions at any time by running the checkout command above.

---

### Step 6: Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions` in the address bar
2. In the top-right corner, toggle **Developer mode** ON
3. Click **Load unpacked** (top-left area)
4. Navigate to the folder where you cloned the repo
5. Select the **`src`** folder inside it (e.g., `~/dev/portility-extension/src`)
6. Click **Select Folder**
7. You should see "Portility DEV" appear in your extensions list

---

### Step 7: Verify it works

1. Go to https://claude.ai (or https://chatgpt.com or https://gemini.google.com)
2. Open or start a conversation with at least one message exchange
3. Click the Portility icon in the Chrome toolbar
4. Try extracting a conversation

---

## Daily Workflow (for developers)

**Pull the latest changes** (do this before starting work):
```bash
cd ~/dev/portility-extension
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

**After pulling or switching branches, reload the extension:**
1. Go to `chrome://extensions`
2. Click the reload icon (circular arrow) on Portility DEV

---

## If you get a merge conflict

This happens when two people edit the same lines. Git will tell you which files have conflicts.

1. Open the conflicted files in a text editor
2. Look for markers like `<<<<<<<`, `=======`, and `>>>>>>>`
3. Choose which version to keep and delete the markers
4. Save the files, then run:

```bash
git add -A
git commit -m "Resolve merge conflict"
git push
```

---

## Tips

- **Always pull before you push** — avoids conflicts
- **Always reload the extension** after pulling new code or switching branches
- **Commit often** with small, descriptive messages
- **Don't edit the same file at the same time** as someone else — coordinate first
- If something goes wrong, `git status` and `git log` are your friends
- If you get stuck, ask Andrew for help
