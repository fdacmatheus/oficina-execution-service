output "dynamodb_table" {
  value = aws_dynamodb_table.execucoes.name
}

output "execution_comandos_url" {
  value = aws_sqs_queue.comandos.url
}

output "execution_comandos_dlq_url" {
  value = aws_sqs_queue.comandos_dlq.url
}
