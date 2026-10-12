#!/usr/bin/env bash
# 由 src/renderer/index.html **现场生成**一份带驱动脚本的桌宠页面。
# 之所以生成而不是手抄一份：手抄的副本会跟 index.html 脱节，
# 以后改了 DOM 结构测试页还在跑旧结构，测了个寂寞。
# 只需要改两处相对路径（页面在 debug/ 下，./style.css 会 404）。
# 用法： ./debug/gen-driver.sh [驱动脚本名，默认 driver.js]
set -eu
cd "$(dirname "$0")/.." || exit 1

DRV="${1:-driver.js}"

sed -e 's#href="\./style\.css"#href="/src/renderer/style.css"#' \
    -e 's#src="\./pet\.js"#src="/src/renderer/pet.js"#' \
    -e "s#</body>#  <script type=\"module\" src=\"/debug/$DRV\"></script>\\n</body>#" \
    src/renderer/index.html > debug/pet-driver.html

echo "generated debug/pet-driver.html  (driver=$DRV):"
grep -n 'style.css\|pet.js\|driver' debug/pet-driver.html || true
