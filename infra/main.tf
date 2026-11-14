terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend parcial: bucket/key/region chegam no `terraform init -backend-config=...`.
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Projeto = "oficina"
      Servico = "execution-service"
    }
  }
}

# Tabela unica do servico (ver README: modelagem e padroes de acesso).
resource "aws_dynamodb_table" "execucoes" {
  name         = var.tabela
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }

  # Itens de inbox (MSG#) expiram sozinhos.
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_sqs_queue" "comandos_dlq" {
  name                      = "execution-comandos-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "comandos" {
  name                       = "execution-comandos"
  visibility_timeout_seconds = 30
  receive_wait_time_seconds  = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.comandos_dlq.arn
    maxReceiveCount     = 5
  })
}
