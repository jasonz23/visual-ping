#!/bin/sh
h=$(curl -s --retry 3 --max-time 20 -D - -o /dev/null -u "$VP_USER:$VP_PASS" "$1" | tr -d '\r')
if [ -z "$h" ]; then echo "FAILED $1"; exit 0; fi
echo "$h" | grep -v '^$' | sed "s|^|$1\t|"
