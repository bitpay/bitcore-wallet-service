@echo off
start node messagebroker\messagebroker.js
start node locker\locker.js
start node bcmonitor\bcmonitor.js
node bws.js
