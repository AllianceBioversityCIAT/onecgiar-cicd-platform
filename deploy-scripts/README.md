# deploy-scripts

Version-controlled deployment scripts executed on target hosts (design DD-10, DD-11, §6.4).

The generic `deploy-container.sh` arrives in task T-14. It is packaged into the Executor image and uploaded over SFTP for each execution; it is never pre-installed on hosts.
