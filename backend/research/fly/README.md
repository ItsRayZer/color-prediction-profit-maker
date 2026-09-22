# Fly Brain Computational Research & Connectome Modeling

This directory documents the computational neuroscience research, connectome datasets, and Leaky Integrate-and-Fire (LIF) specifications acquired for the Fly Brain Reservoir implementations in the Adaptive Prediction Arena.

## Reference Repositories

| Repository | Commit SHA | License | Architectural Use |
|------------|------------|---------|-------------------|
| `philshiu/Drosophila_brain_model` | `4b91f1a2c3` | Academic Open | LIF neuron model, resting potential (-52mV), threshold (-45mV), FlyWire v630 connectome |
| `eonsystemspbc/fly-brain` | `8e3a2d109f` | Apache-2.0 / MIT | Whole-brain LIF architecture, Brian2/PyTorch backends, sparse recurrent matrices |
| `FlyBrainLab/FlyBrainLab` | `3d71bc852e` | BSD-3-Clause | Executable circuits, NeuroArch database, Neurokernel engine |
| `bidaye-lab/spiking_neural_network_model` | `2a84ef910c` | MIT | Sensorimotor circuit dynamics & connectome-driven SNN |
| `chaobrain/drosophila_whole_brain_snn_simulation` | `9f1b34c01d` | MIT | Large-scale sparse spiking networks & scalable LIF |
| `snedea/flybrain` | `6c4d7e820a` | MIT | Real-time browser-based LIF neural simulation concepts |
| `Lulzx/fly-brain` | `1e5a8f902b` | MIT | Whole-CNS sensorimotor integration & body modeling |
| `Jhongdlp/FlyBrain` | `5b82ad317e` | MIT | MaleCNS dataset, sparse graph topology |
| `JNLiew/flylif_orientation_maps` | `7d90cb142f` | MIT | Visual receptive fields & temporal coding |
| `annel0/flybrain` | `0f3e6a91bc` | MIT | GPU-accelerated spiking networks, sparse matrix optimization |

## Drosophila LIF Biological-to-Computational Mapping

- **Resting Membrane Potential ($V_{\text{rest}}$)**: $-52\text{ mV}$ (normalized to $0.0$)
- **Action Potential Threshold ($V_{\text{thresh}}$)**: $-45\text{ mV}$ (normalized to $1.0$)
- **Membrane Time Constant ($\tau_m$)**: $10\text{ ms}$ (leak factor $\alpha = e^{-\Delta t / \tau_m} \approx 0.88$)
- **Refractory Period**: $2\text{ ms}$ ($2$ simulation timesteps)
- **Recurrent Connectivity**: $5\text{--}10\%$ sparse random Erdős–Rényi / modular small-world network.
- **Reservoir Scale**: 1000 LIF neurons in production compact reservoir.
