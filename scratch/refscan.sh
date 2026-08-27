#!/bin/sh
url="$1"
a=$(curl -s -u "$VP_USER:$VP_PASS" "$url" | md5)
b=$(curl -s -u "$VP_USER:$VP_PASS" -e "http://54.214.7.161/" "$url" | md5)
[ "$a" != "$b" ] && echo "DIFF $url"
exit 0
