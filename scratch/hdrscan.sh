#!/bin/sh
url="$1"
curl -s -D - -o /dev/null -u "$VP_USER:$VP_PASS" "$url" \
 | grep -viE '^(HTTP/|Server:|Date:|Content-Type:|Content-Length:|Connection:|Accept-Ranges:|Last-Modified:|ETag:|Location:|WWW-Authenticate:)' \
 | tr -d '\r' | grep -v '^$' | sed "s|^|$url  |"
