#!/bin/sh
url="$1"; want="$2"
got=$(curl -s -u "$VP_USER:$VP_PASS" "$url" | shasum -a 256 | cut -d' ' -f1)
[ "$got" != "$want" ] && echo "DIFF $url  stored=$want curl=$got"
exit 0
