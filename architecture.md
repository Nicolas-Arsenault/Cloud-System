## Job Flow

<img width="1098" height="806" alt="image" src="https://github.com/user-attachments/assets/1f9b4dda-8cfd-4429-a0fd-56c13b892074" />


## Secret management strategy

In this project we used a simple .env to load secrets. Although in production, we should use alternatives like OpenBao or a paid cloud secrets manager like AWS.

## Logging + monitoring approach

Here we enabled classic logging to a database so that we can debug remotely our Cloud infra. We have different levels like debug, info, warning, error and fatal. Since this is a mini project, we did not implement a custom logger sink which would be a separate service with SMS alerting integrated, but this would be needed at scale. It would basically feed upon a list of on calls engineers and message them. 

Currently, we tie some metadata to the logs and on which worker it happened/endpoint to improve debugging.

## Failure isolation strategy

In our architecture we have multiple layers for failure isolation. We have exponential backoff on certain types of errors (like network errors). We also share a failure count across workers per retailer so that we can open a circuit breaker (which is also shared amongst workers) in case that the threshold is passed. We also have a automatic retry strategy in case a worker crashes, his pending job will be taken over by another worker which has a semaphore available. This is possible because of separate streams per retailer instead of a simple queue. 

In a production application we would also add a global exception handler.
