#!/bin/sh
# A stand-in Host's start (tests/e2e/Containerfile): new host keys, its ssh client connecting from its own address,
# busybox's httpd on WEB when that's set (basic auth for /api), and sshd on ADDR:PORT in the foreground.
ssh-keygen -A >/dev/null
echo "BindAddress $ADDR" >> /etc/ssh/ssh_config
if [ -n "$WEB" ]; then
    httpd -p "$ADDR:$WEB" -h /srv/www -c /etc/httpd.conf
fi
exec /usr/sbin/sshd -D -e -o "ListenAddress=$ADDR:$PORT" -o PasswordAuthentication=yes -o UseDNS=no \
    -o MaxStartups=100
