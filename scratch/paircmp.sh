#!/bin/sh
a=$(curl -s -u "$VP_USER:$VP_PASS" "$1" | shasum -a 256 | cut -d' ' -f1)
b=$(curl -s -u "$VP_USER:$VP_PASS" "$2" | shasum -a 256 | cut -d' ' -f1)
[ "$a" != "$b" ] && echo "DIFFERS: $1  vs  $2"
exit 0
