#!/bin/bash
#
# DeepCode — Build, Package & Install VSIX
# Usage: ./build.sh [--install] [--clean]
#
#   --install   Install the extension into VS Code after building
#   --clean     Remove out/ and old .vsix files before building
#

set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Parse flags
DO_INSTALL=false
DO_CLEAN=false
for arg in "$@"; do
    case "$arg" in
        --install) DO_INSTALL=true ;;
        --clean)   DO_CLEAN=true ;;
        --help|-h)
            echo "Usage: ./build.sh [--install] [--clean]"
            echo "  --install   Install the extension into VS Code after building"
            echo "  --clean     Remove out/ and old .vsix files before building"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $arg${NC}"
            echo "Usage: ./build.sh [--install] [--clean]"
            exit 1
            ;;
    esac
done

# Resolve script directory so it works from anywhere
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      DeepCode — VSIX Builder         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# Step 1: Check prerequisites
echo -e "${YELLOW}[1/6]${NC} Checking prerequisites..."

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

if $DO_INSTALL; then
    if ! command -v code &> /dev/null; then
        echo -e "${RED}✗ 'code' CLI not found. Open VS Code and run:${NC}"
        echo -e "  ${YELLOW}Cmd+Shift+P → Shell Command: Install 'code' command in PATH${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}✓${NC} VS Code CLI available"
fi

# Step 2: Clean (optional)
echo ""
if $DO_CLEAN; then
    echo -e "${YELLOW}[2/6]${NC} Cleaning previous build..."
    rm -rf out/
    rm -f *.vsix
    echo -e "  ${GREEN}✓${NC} Cleaned out/ and old .vsix files"
else
    echo -e "${YELLOW}[2/6]${NC} Skipping clean (use --clean to remove old artifacts)"
fi

# Step 3: Install dependencies
echo ""
echo -e "${YELLOW}[3/6]${NC} Installing dependencies..."
npm install --silent
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# Step 4: Compile TypeScript
echo ""
echo -e "${YELLOW}[4/6]${NC} Compiling TypeScript..."
npm run compile
echo -e "  ${GREEN}✓${NC} Compilation successful"

# Step 5: Run lint (optional, don't fail the build)
echo ""
echo -e "${YELLOW}[5/6]${NC} Running checks..."
if [ -f "node_modules/.bin/eslint" ]; then
    npm run lint 2>/dev/null && echo -e "  ${GREEN}✓${NC} Lint passed" || echo -e "  ${YELLOW}⚠${NC} Lint warnings (non-blocking)"
else
    echo -e "  ${YELLOW}⚠${NC} ESLint not installed, skipping"
fi

if [ ! -d "out" ]; then
    echo -e "${RED}✗ Compilation output not found in out/${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Build artifacts verified"

# Verify runtime assets
if [ ! -d "parsers" ] || [ -z "$(ls parsers/*.wasm 2>/dev/null)" ]; then
    echo -e "${RED}✗ Tree-sitter .wasm parsers missing from parsers/${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓${NC} Tree-sitter parsers present"

# Step 6: Package VSIX
echo ""
echo -e "${YELLOW}[6/6]${NC} Packaging VSIX..."

VERSION=$(node -e "console.log(require('./package.json').version)")
NAME=$(node -e "console.log(require('./package.json').name)")
VSIX_FILE="${NAME}-${VERSION}.vsix"

# Remove previous vsix with same name to avoid stale artifacts
rm -f "$VSIX_FILE"

npx @vscode/vsce package --no-dependencies --allow-missing-repository

if [ ! -f "$VSIX_FILE" ]; then
    echo -e "${RED}✗ Expected $VSIX_FILE but file not found after packaging.${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Build Successful!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Package:  ${BLUE}${VSIX_FILE}${NC}"
echo -e "  Size:     $(du -h "$VSIX_FILE" | awk '{print $1}')"
echo ""

if $DO_INSTALL; then
    echo -e "  ${YELLOW}Installing into VS Code...${NC}"
    code --install-extension "$VSIX_FILE" --force
    echo -e "  ${GREEN}✓${NC} Installed! Reload VS Code to activate."
else
    echo -e "  Install with:"
    echo -e "    ${YELLOW}code --install-extension ${VSIX_FILE}${NC}"
    echo -e "  Or re-run:"
    echo -e "    ${YELLOW}./build.sh --install${NC}"
fi
echo ""
