#!/bin/sh
curl -s -D - -o /dev/null -u "$VP_USER:$VP_PASS" "$1" | tr -d '\r' | grep '^HTTP/'
