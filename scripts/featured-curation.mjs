// The curated input for v1/featured-models.json. Which models appear, how they
// are described, and how they rank is a judgement, and it lives here. Every
// other value (sizes, files, parameters, context) is read by the builder from
// v1/ollama-models.json and the Hugging Face API, and a reference it cannot
// confirm fails the build.
//
// The scheduled refresh never edits this file. Adding, dropping, or replacing a
// model is a reviewed change to this file.
//
// Per model:
//   ollama  the Ollama tag, read from v1/ollama-models.json
//   gguf    a Hugging Face repository with a single-file GGUF
//   mlx     a Hugging Face MLX repository; the whole repository is the download
//   base    the publisher's original repository, for rows with no Ollama tag:
//           parameters come from it, context from the MLX config.json
//   tier    frontier | excellent | strong | good (see README)
//   coding  true when the model is good at writing code ("coding" tag)
//   watch   the start of a repository name for the newer-versions report,
//           e.g. "GLM-" or "MiniMax-M"
//
// No image-generation entries: no runtime Nexus ships (Ollama, llama.cpp, MLX)
// can generate images, so a featured image model would offer a download that
// runs nowhere.

export const MODELS = [
  // --- start-here ---
  {
    id: "qwen3.5-9b", name: "Qwen3.5 9B", publisher: "Qwen",
    summary: "Strong all-round chat with a very long context. A good first model.",
    capabilities: ["chat", "tools", "reasoning", "vision"],
    ollama: "qwen3.5:9b", gguf: "unsloth/Qwen3.5-9B-GGUF", mlx: "mlx-community/Qwen3.5-9B-MLX-4bit",
    tier: "good", watch: "Qwen3.",
  },
  {
    id: "gemma4-12b", name: "Gemma 4 12B", publisher: "Google",
    summary: "Frontier-level quality at a size a laptop can hold.",
    capabilities: ["chat", "tools", "vision"],
    ollama: "gemma4:12b", gguf: "unsloth/gemma-4-12b-it-GGUF", mlx: "mlx-community/gemma-4-12B-it-qat-4bit",
    tier: "good", watch: "gemma-4",
  },
  {
    id: "lfm2.5-8b", name: "LFM2.5 8B", publisher: "Liquid AI",
    summary: "Built for fast, reliable tool calling on consumer hardware.",
    capabilities: ["chat", "tools"],
    ollama: "lfm2.5:8b", gguf: "LiquidAI/LFM2.5-8B-A1B-GGUF", mlx: "mlx-community/LFM2.5-8B-A1B-MLX-4bit",
    tier: "good", watch: "LFM",
  },
  {
    id: "ministral-3-8b", name: "Ministral 3 8B", publisher: "Mistral AI",
    summary: "Mistral's edge family, sized to run on a single machine.",
    capabilities: ["chat", "tools"],
    ollama: "ministral-3:8b", gguf: "mistralai/Ministral-3-8B-Instruct-2512-GGUF",
    mlx: "mlx-community/Ministral-3-8B-Instruct-2512-4bit",
    tier: "good", watch: "Ministral",
  },
  // --- everyday ---
  {
    id: "qwen3.8-27b", name: "Qwen3.8 27B", publisher: "Qwen",
    summary: "Qwen's flagship open model, strong on coding and research.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "qwen3.8:27b", gguf: "ggml-org/Qwen3.8-27B-GGUF", mlx: "mlx-community/Qwen3.8-27B-4bit",
    tier: "strong", coding: true, watch: "Qwen3.",
  },
  {
    id: "qwen3.6-35b", name: "Qwen3.6 35B", publisher: "Qwen",
    summary: "A mixture-of-experts model tuned for agentic coding and long thinking.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "qwen3.6:35b", gguf: "unsloth/Qwen3.6-35B-A3B-GGUF", mlx: "mlx-community/Qwen3.6-35B-A3B-4bit",
    tier: "strong", coding: true, watch: "Qwen3.",
  },
  {
    id: "glm-4.7-flash", name: "GLM-4.7 Flash", publisher: "Z.ai",
    summary: "The strongest of the 30B class, with a 198K context window.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "glm-4.7-flash:latest", gguf: "ggml-org/GLM-4.7-Flash-GGUF", mlx: "mlx-community/GLM-4.7-Flash-4bit",
    tier: "strong", coding: true, watch: "GLM-",
  },
  {
    id: "nemotron-3.5-lightning", name: "Nemotron 3.5 Lightning 30B", publisher: "NVIDIA",
    summary: "A 30B mixture-of-experts model with a one-million-token context.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "nemotron-3.5-lightning:30b", gguf: "ggml-org/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
    mlx: "mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-4bit",
    tier: "strong", watch: "NVIDIA-Nemotron",
  },
  {
    id: "gpt-oss-20b", name: "gpt-oss 20B", publisher: "OpenAI",
    summary: "OpenAI's open-weight model for reasoning and agentic work.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "gpt-oss:20b", gguf: "ggml-org/gpt-oss-20b-GGUF", mlx: "mlx-community/gpt-oss-20b-MXFP4-Q8",
    tier: "good", watch: "gpt-oss",
  },
  {
    id: "muse-glimmer-30b", name: "Muse Glimmer 30B", publisher: "Meta",
    summary: "Meta's open model for always-on local agents.",
    capabilities: ["chat", "tools"],
    ollama: "muse-glimmer:30b", gguf: "meta-models/Muse-Glimmer-30B-GGUF", mlx: "mlx-community/Muse-Glimmer-30B-4bit",
    tier: "strong", watch: "Muse",
  },
  // --- coding ---
  {
    id: "ornith-9b", name: "Ornith 1.0 9B", publisher: "Ornith",
    summary: "A self-improving model for agentic coding, small enough for a laptop.",
    capabilities: ["chat", "code", "tools"],
    ollama: "ornith:9b", gguf: "ornith-ai/Ornith-1.0-9B-GGUF", mlx: "mlx-community/Ornith-1.0-9B-4bit",
    tier: "good", coding: true, watch: "Ornith",
  },
  {
    id: "ornith-35b", name: "Ornith 1.0 35B", publisher: "Ornith",
    summary: "The larger Ornith, for coding work that needs the headroom.",
    capabilities: ["chat", "code", "tools"],
    ollama: "ornith:35b", gguf: "ornith-ai/Ornith-1.0-35B-GGUF", mlx: "mlx-community/Ornith-1.0-35B-4bit",
    tier: "strong", coding: true, watch: "Ornith",
  },
  {
    id: "north-mini-code", name: "North Mini Code 1.0", publisher: "Cohere",
    summary: "Cohere's developer model: 30B mixture-of-experts, 488K context.",
    capabilities: ["chat", "code", "tools"],
    ollama: "north-mini-code-1.0:latest", gguf: "unsloth/North-Mini-Code-1.0-GGUF",
    mlx: "mlx-community/North-Mini-Code-1.0-4bit",
    tier: "strong", coding: true, watch: "North",
  },
  {
    id: "laguna-xs-2.1", name: "Laguna XS 2.1", publisher: "poolside",
    summary: "A 33B mixture-of-experts model with 3B active, built for long-horizon work.",
    capabilities: ["chat", "code", "tools"],
    ollama: "laguna-xs-2.1:latest", gguf: "poolside/Laguna-XS-2.1-GGUF", mlx: "mlx-community/Laguna-XS-2.1-4bit",
    tier: "strong", coding: true, watch: "Laguna",
  },
  {
    id: "qwen3-coder-next", name: "Qwen3 Coder Next", publisher: "Qwen",
    summary: "Qwen's coding-focused model for agentic editing across a codebase.",
    capabilities: ["chat", "code", "tools"],
    ollama: "qwen3-coder-next:latest", gguf: "unsloth/Qwen3-Coder-Next-GGUF", mlx: "mlx-community/Qwen3-Coder-Next-4bit",
    tier: "strong", coding: true, watch: "Qwen3-Coder",
  },
  // --- reasoning ---
  {
    id: "lfm2.5-thinking", name: "LFM2.5 Thinking 1.2B", publisher: "Liquid AI",
    summary: "Shows its working, and still fits in under a gigabyte.",
    capabilities: ["chat", "reasoning"],
    ollama: "lfm2.5-thinking:1.2b", gguf: "LiquidAI/LFM2.5-1.2B-Thinking-GGUF",
    mlx: "mlx-community/LFM2.5-1.2B-Thinking-4bit",
    tier: "good", watch: "LFM",
  },
  {
    id: "olmo-3.1-think", name: "Olmo 3.1 32B Think", publisher: "Ai2",
    summary: "A fully open model — weights, data, and training — tuned to reason.",
    capabilities: ["chat", "reasoning"],
    ollama: "olmo-3.1:32b-think", gguf: "bartowski/allenai_Olmo-3.1-32B-Think-GGUF",
    mlx: "mlx-community/Olmo-3.1-32B-Think-4bit",
    tier: "good", watch: "Olmo",
  },
  {
    id: "nemotron-3-nano", name: "Nemotron 3 Nano 30B", publisher: "NVIDIA",
    summary: "Efficient agentic reasoning with a one-million-token context.",
    capabilities: ["chat", "reasoning", "tools"],
    ollama: "nemotron-3-nano:30b", gguf: "unsloth/Nemotron-3-Nano-30B-A3B-GGUF",
    mlx: "mlx-community/NVIDIA-Nemotron-3-Nano-30B-A3B-4bit",
    tier: "good", watch: "NVIDIA-Nemotron",
  },
  // --- vision ---
  {
    id: "qwen3-vl-8b", name: "Qwen3-VL 8B", publisher: "Qwen",
    summary: "Reads screenshots, documents, and charts, and answers questions about them.",
    capabilities: ["chat", "vision"],
    ollama: "qwen3-vl:8b", gguf: "unsloth/Qwen3-VL-8B-Instruct-GGUF", mlx: "mlx-community/Qwen3-VL-8B-Instruct-4bit",
    tier: "good", watch: "Qwen3-VL",
  },
  {
    id: "minicpm-v4.6", name: "MiniCPM-V 4.6", publisher: "OpenBMB",
    summary: "A pocket-sized vision model for image and video understanding.",
    capabilities: ["chat", "vision"],
    ollama: "minicpm-v4.6:1b", gguf: "openbmb/MiniCPM-V-4.6-gguf", mlx: "mlx-community/MiniCPM-V-4.6-4bit",
    tier: "good", watch: "MiniCPM",
  },
  {
    id: "glm-ocr", name: "GLM-OCR", publisher: "Z.ai",
    summary: "Turns complex documents into text. Small enough to keep loaded.",
    capabilities: ["vision"],
    ollama: "glm-ocr:latest", gguf: "ggml-org/GLM-OCR-GGUF", mlx: "mlx-community/GLM-OCR-4bit",
    tier: "good", watch: "GLM-OCR",
  },
  {
    id: "deepseek-ocr", name: "DeepSeek-OCR", publisher: "DeepSeek",
    summary: "Token-efficient OCR, for putting scanned pages into a pipeline.",
    capabilities: ["vision"],
    ollama: "deepseek-ocr:3b", gguf: "ggml-org/DeepSeek-OCR-GGUF", mlx: "mlx-community/DeepSeek-OCR-8bit",
    tier: "good", watch: "DeepSeek-OCR",
  },
  // --- small ---
  {
    id: "qwen3.5-0.8b", name: "Qwen3.5 0.8B", publisher: "Qwen",
    summary: "Under a gigabyte, and still holds a conversation.",
    capabilities: ["chat"],
    ollama: "qwen3.5:0.8b", gguf: "unsloth/Qwen3.5-0.8B-GGUF", mlx: "mlx-community/Qwen3.5-0.8B-4bit",
    tier: "good",
  },
  {
    id: "qwen3.5-2b", name: "Qwen3.5 2B", publisher: "Qwen",
    summary: "The smallest Qwen3.5 that still does tool calling well.",
    capabilities: ["chat", "tools"],
    ollama: "qwen3.5:2b", gguf: "bartowski/Qwen_Qwen3.5-2B-GGUF", mlx: "mlx-community/Qwen3.5-2B-MLX-8bit",
    tier: "good",
  },
  {
    id: "granite4.1-3b", name: "Granite 4.1 3B", publisher: "IBM",
    summary: "An enterprise-ready small model with a 128K context.",
    capabilities: ["chat", "tools"],
    ollama: "granite4.1:3b", gguf: "ibm-granite/granite-4.1-3b-GGUF", mlx: "mlx-community/granite-4.1-3b-4bit",
    tier: "good", watch: "granite",
  },
  // --- embeddings ---
  {
    id: "qwen3-embedding-0.6b", name: "Qwen3 Embedding 0.6B", publisher: "Qwen",
    summary: "Turns text into vectors for search. Small enough to run beside a chat model.",
    capabilities: ["embeddings"],
    ollama: "qwen3-embedding:0.6b", gguf: "Qwen/Qwen3-Embedding-0.6B-GGUF", mlx: "mlx-community/Qwen3-Embedding-0.6B-8bit",
    tier: "good", watch: "Qwen3-Embedding",
  },
  {
    id: "embeddinggemma-300m", name: "EmbeddingGemma 300M", publisher: "Google",
    summary: "A 300M embedding model, quantization-aware trained.",
    capabilities: ["embeddings"],
    ollama: "embeddinggemma:300m", gguf: "ggml-org/embeddinggemma-300M-GGUF", mlx: "mlx-community/embeddinggemma-300m-4bit",
    tier: "good",
  },
  {
    id: "bge-m3", name: "BGE-M3", publisher: "BAAI",
    summary: "Multilingual embeddings for search across many languages at once.",
    capabilities: ["embeddings"],
    ollama: "bge-m3:567m", gguf: "gpustack/bge-m3-GGUF", mlx: "mlx-community/bge-m3-mlx-4bit",
    tier: "good",
  },
  // --- big machines ---
  {
    id: "gpt-oss-120b", name: "gpt-oss 120B", publisher: "OpenAI",
    summary: "The larger open-weight OpenAI model, for workstations with real memory.",
    capabilities: ["chat", "tools", "reasoning"],
    ollama: "gpt-oss:120b", gguf: "ggml-org/gpt-oss-120b-GGUF", mlx: "mlx-community/gpt-oss-120b-MXFP4-Q8",
    tier: "strong", watch: "gpt-oss",
  },
  {
    id: "qwen3.5-122b", name: "Qwen3.5 122B", publisher: "Qwen",
    summary: "The full Qwen3.5. Needs a workstation, and rewards one.",
    capabilities: ["chat", "tools", "reasoning", "vision"],
    ollama: "qwen3.5:122b", gguf: "unsloth/Qwen3.5-122B-A10B-GGUF", mlx: "mlx-community/Qwen3.5-122B-A10B-4bit",
    tier: "strong", watch: "Qwen3.",
  },
  // --- cluster ---
  // Too large for one Mac, so most have no local Ollama tag and every GGUF of
  // them is sharded; MLX is the install. Only families the Msty Nexus cluster
  // worker can split across Macs belong here (msty-nexus
  // internal/cluster/model_capabilities.go), and none may need
  // trust_remote_code to load, because the worker never passes it.
  {
    id: "muse-spark-open", name: "Muse Spark Open 816B", publisher: "Meta",
    summary: "Meta's largest open model, with a one-million-token context.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/Muse-Spark-Open-816B-A42B-4bit", base: "meta-models/Muse-Spark-Open-816B-A42B",
    tier: "frontier", watch: "Muse",
  },
  {
    id: "glm-5.3", name: "GLM-5.3", publisher: "Z.ai",
    summary: "Z.ai's flagship, strong at agentic coding, with a one-million-token context.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/GLM-5.3-4bit", base: "zai-org/GLM-5.3-BF16",
    tier: "frontier", coding: true, watch: "GLM-",
  },
  {
    id: "deepseek-v3.2", name: "DeepSeek V3.2", publisher: "DeepSeek",
    summary: "DeepSeek's flagship, with sparse attention for long inputs.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/DeepSeek-V3.2-4bit", base: "deepseek-ai/DeepSeek-V3.2",
    tier: "excellent", coding: true, watch: "DeepSeek-V",
  },
  {
    id: "qwen3-coder-480b", name: "Qwen3 Coder 480B", publisher: "Qwen",
    summary: "Qwen's largest coding model, for agentic work across a repository.",
    capabilities: ["chat", "code", "tools"],
    ollama: "qwen3-coder:480b", mlx: "mlx-community/Qwen3-Coder-480B-A35B-Instruct-4bit",
    tier: "excellent", coding: true, watch: "Qwen3-Coder",
  },
  {
    id: "qwen3.5-397b", name: "Qwen3.5 397B", publisher: "Qwen",
    summary: "The largest Qwen3.5, for chat, research, and code.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/Qwen3.5-397B-A17B-4bit", base: "Qwen/Qwen3.5-397B-A17B",
    tier: "excellent", coding: true, watch: "Qwen3.",
  },
  {
    id: "glm-4.7", name: "GLM-4.7", publisher: "Z.ai",
    summary: "Z.ai's previous flagship, strong at coding and tool use, at half the size of GLM-5.3.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/GLM-4.7-4bit", base: "zai-org/GLM-4.7",
    tier: "excellent", coding: true, watch: "GLM-",
  },
  {
    id: "minimax-m2.7", name: "MiniMax M2.7", publisher: "MiniMax",
    summary: "A compact mixture-of-experts model built for coding and agent work.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/MiniMax-M2.7-4bit", base: "MiniMaxAI/MiniMax-M2.7",
    tier: "excellent", coding: true, watch: "MiniMax-M",
  },
  {
    id: "glm-4.5-air", name: "GLM-4.5 Air", publisher: "Z.ai",
    summary: "A lighter GLM that two smaller Macs can share.",
    capabilities: ["chat", "tools", "reasoning"],
    mlx: "mlx-community/GLM-4.5-Air-4bit", base: "zai-org/GLM-4.5-Air",
    tier: "strong", coding: true, watch: "GLM-",
  },
];

export const COLLECTIONS = [
  {
    id: "start-here", title: "Start here",
    description: "If you have never run a model locally, one of these.",
    models: ["qwen3.5-9b", "gemma4-12b", "lfm2.5-8b", "ministral-3-8b"],
  },
  {
    id: "everyday", title: "Everyday chat",
    description: "General assistants for writing, summarising, and answering questions.",
    models: ["qwen3.8-27b", "qwen3.6-35b", "glm-4.7-flash", "nemotron-3.5-lightning", "gpt-oss-20b",
      "muse-glimmer-30b"],
  },
  {
    id: "coding", title: "For writing code",
    description: "Tuned for completion, refactoring, and working inside a codebase.",
    models: ["ornith-9b", "ornith-35b", "north-mini-code", "laguna-xs-2.1", "qwen3-coder-next"],
  },
  {
    id: "reasoning", title: "Thinks before it answers",
    description: "Slower, and better at maths, logic, and multi-step problems.",
    models: ["lfm2.5-thinking", "olmo-3.1-think", "nemotron-3-nano"],
  },
  {
    id: "vision", title: "Reads images",
    description: "Answers questions about screenshots, documents, and photographs.",
    models: ["qwen3-vl-8b", "minicpm-v4.6", "glm-ocr", "deepseek-ocr"],
  },
  {
    id: "small", title: "Runs on almost anything",
    description: "A few billion parameters at most, for older machines and small devices.",
    models: ["qwen3.5-0.8b", "qwen3.5-2b", "granite4.1-3b"],
  },
  {
    id: "embeddings", title: "Search and retrieval",
    description: "Turn documents into vectors. Pair one with a chat model for RAG.",
    models: ["qwen3-embedding-0.6b", "embeddinggemma-300m", "bge-m3"],
  },
  {
    id: "big-machines", title: "If you have the memory",
    description: "Large models for workstations. Check the fit before downloading.",
    models: ["gpt-oss-120b", "qwen3.5-122b"],
  },
  // Msty Nexus Cluster Advisor reads this collection by id, so the id is a
  // contract.
  {
    id: "cluster", title: "For a Mac cluster",
    description: "Too large for one Mac. Split across a Thunderbolt-connected cluster.",
    models: ["muse-spark-open", "glm-5.3", "deepseek-v3.2", "qwen3-coder-480b", "qwen3.5-397b", "glm-4.7",
      "minimax-m2.7", "qwen3.5-122b", "gpt-oss-120b", "glm-4.5-air"],
  },
];
