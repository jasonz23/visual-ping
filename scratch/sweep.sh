#!/bin/sh
curl -s --max-time 15 -u "$VP_USER:$VP_PASS" "http://54.214.7.161/report/?page=$1" | grep -o "VISUALPING{[0-9a-fA-F]\{16\}}"
exit 0
