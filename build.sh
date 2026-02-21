#!/bin/bash
#
# DeepCode — Build & Package VSIX
# Usage: ./build.sh
#

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      DeepCode — VSIX Builder         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check prerequisites
echo -e "${YELLOW}[1/5]${NC} Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed. Please install it first.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node --version)"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm is not installed.${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm --version)"

# Check/install vsce
if ! command -v vsce &> /dev/null; then
    echo -e "  ${YELLOW}→${NC} Installing @vscode/vsce globally..."
    npm install -g @vscode/vsce
fi
echo -e "  ${GREEN}✓${NC} vsce $(vsce --version)"

# Step 2: Install dependencies
echo ""
echo -e "${YELLOW}[2/5]${NC} Installing dependencies..."
npm install --silent
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# Step 3: Compile TypeScript
echo ""
echo -e "${YELLOW}[3/5]${NC} Compiling TypeScript..."
npm run compile
echo -e "  ${GREEN}✓${NC} Compilation successful"

# Step 4: Run lint (optional, don't fail)
echo ""
echo -e "${YELLOW}[4/5]${NC} Running checks..."
if [ -f "node_modules/.bin/eslint" ]; then
    npm run lint 2>/dev/null && echo -e "  ${GREEN}✓${NC} Lint passed" || echo -e "  ${YELLOW}⚠${NC} Lint skipped (non-blocking)"
else
    echo -e "  ${YELLOW}⚠${NC} ESLint not installed, skipping"
fi

# Verify out/ exists
if [ ! -d "out" ]; then
    echo -e "${RED}✗ Compilation output not found in out/${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Build artifacts verified"

# Step 5: Package VSIX
echo ""
echo -e "${YELLOW}[5/5]${NC} Packaging VSIX..."

# Extract version from package.json
VERSION=$(node -e "console.log(require('./package.json').version)")
NAME=$(node -e "console.log(require('./package.json').name)")
VSIX_FILE="${NAME}-${VERSION}.vsix"

vsce package --no-dependencies --allow-missing-repository

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Build Successful!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Package:  ${BLUE}${VSIX_FILE}${NC}"
echo -e "  Size:     $(du -h *.vsix | tail -1 | awk '{print $1}')"
echo ""
echo -e "  Install with:"
echo -e "    ${YELLOW}code --install-extension ${VSIX_FILE}${NC}"
echo ""
