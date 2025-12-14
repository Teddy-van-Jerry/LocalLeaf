import './index.css'

const VSCODE_MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=teddy-van-jerry.localleaf'
const GITHUB_URL = 'https://github.com/Teddy-van-Jerry/LocalLeaf'
const DOCS_URL = 'https://github.com/Teddy-van-Jerry/LocalLeaf#readme'

function Hero() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden">
      {/* Floating particles */}
      <div className="absolute inset-0 pointer-events-none">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className="absolute w-2 h-2 bg-green-400 opacity-60"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animation: `float ${3 + Math.random() * 2}s ease-in-out infinite`,
              animationDelay: `${Math.random() * 2}s`,
            }}
          />
        ))}
      </div>

      {/* Logo */}
      <div className="animate-float animate-glow" style={{ marginBottom: '3rem' }}>
        <img
          src="./images/icon.svg"
          alt="LocalLeaf Logo"
          className="w-32 h-32 md:w-48 md:h-48"
        />
      </div>

      {/* Title */}
      <h1 className="font-minecraft text-2xl md:text-4xl text-white text-center mb-4 animate-pixel-fade"
          style={{ textShadow: '4px 4px 0px #2E7D32' }}>
        LocalLeaf
      </h1>

      {/* Subtitle */}
      <p className="text-xl md:text-3xl text-white text-center mb-8 animate-pixel-fade animate-delay-1"
         style={{ textShadow: '2px 2px 0px rgba(0,0,0,0.5)' }}>
        Local LaTeX Editing yet Synced to Overleaf
      </p>

      {/* Description */}
      <p className="text-lg md:text-2xl text-white/90 text-center max-w-2xl mb-12 animate-pixel-fade animate-delay-2">
        A VS Code extension for seamless Overleaf collaboration while editing locally.
        Works with LaTeX Workshop for the best local editing experience.
      </p>

      {/* CTA Buttons */}
      <div className="flex flex-col sm:flex-row gap-4 animate-pixel-fade animate-delay-3">
        <a
          href={VSCODE_MARKETPLACE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mc-btn mc-btn-green text-center"
        >
          Install Extension
        </a>
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mc-btn text-center"
        >
          Documentation
        </a>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-8 animate-bounce-subtle">
        <div className="w-8 h-12 border-4 border-white/50 rounded-lg flex justify-center pt-2">
          <div className="w-2 h-3 bg-white/70 rounded-sm" />
        </div>
      </div>
    </section>
  )
}

function Features() {
  const features = [
    {
      icon: '🔄',
      title: 'Two-Way Sync',
      description: 'Real-time bidirectional synchronization with your Overleaf projects.',
    },
    {
      icon: '👥',
      title: 'Collaboration',
      description: 'See collaborators\' cursors in real-time. Jump to their positions instantly.',
    },
    {
      icon: '⚡',
      title: 'Auto-Sync',
      description: 'Changes sync automatically as you type. No manual intervention needed.',
    },
    {
      icon: '🔀',
      title: 'Conflict Resolution',
      description: 'Visual diff view for conflicts. Choose local or remote with one click.',
    },
    {
      icon: '📝',
      title: 'LaTeX Workshop',
      description: 'Works seamlessly with LaTeX Workshop for local compilation and preview.',
    },
    {
      icon: '🚫',
      title: 'Ignore Patterns',
      description: 'Configure .leafignore to exclude files from sync, like .gitignore.',
    },
  ]

  return (
    <section className="py-20 px-4 bg-white/10 backdrop-blur-sm">
      <div style={{ maxWidth: '1152px', marginLeft: 'auto', marginRight: 'auto' }}>
        <h2 className="font-minecraft text-xl md:text-2xl text-white text-center mb-12"
            style={{ textShadow: '3px 3px 0px #2E7D32' }}>
          Features
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <div
              key={index}
              className="feature-card p-6 animate-pixel-fade"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              <div className="text-4xl mb-4 text-center">{feature.icon}</div>
              <h3 className="font-minecraft text-sm text-gray-800 mb-2 text-center">
                {feature.title}
              </h3>
              <p className="text-xl text-gray-600 text-center">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Steps() {
  const steps = [
    {
      number: 1,
      title: 'Install Extension',
      description: <>Install LocalLeaf from the <a href={VSCODE_MARKETPLACE_URL} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-500 underline">VS Code Marketplace</a>.</>,
      code: 'ext install teddy-van-jerry.localleaf',
    },
    {
      number: 2,
      title: 'Login to Overleaf',
      description: 'Run "LocalLeaf: Login" and paste your Overleaf cookies.',
      code: 'Ctrl+Shift+P → LocalLeaf: Login',
    },
    {
      number: 3,
      title: 'Link Your Folder',
      description: 'Open a folder and link it to your Overleaf project.',
      code: 'Ctrl+Shift+P → LocalLeaf: Link Folder',
    },
    {
      number: 4,
      title: 'Start Editing!',
      description: 'Edit locally, changes sync automatically. Use LaTeX Workshop for compilation.',
      code: '✨ Real-time sync enabled!',
    },
  ]

  return (
    <section className="py-20 px-4 ground-section">
      <div style={{ maxWidth: '896px', marginLeft: 'auto', marginRight: 'auto', paddingTop: '2rem' }}>
        <h2 className="font-minecraft text-xl md:text-2xl text-white text-center mb-12"
            style={{ textShadow: '3px 3px 0px #3E2723' }}>
          Getting Started
        </h2>

        <div className="space-y-8">
          {steps.map((step, index) => (
            <div
              key={index}
              className="step-card p-6 animate-pixel-fade"
              style={{ animationDelay: `${index * 0.15}s` }}
            >
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-12 h-12 bg-green-600 border-4 border-green-800 flex items-center justify-center">
                  <span className="font-minecraft text-white text-lg">
                    {step.number}
                  </span>
                </div>
                <div className="flex-grow">
                  <h3 className="font-minecraft text-sm text-gray-800 mb-2">
                    {step.title}
                  </h3>
                  <p className="text-xl text-gray-600 mb-3">
                    {step.description}
                  </p>
                  <div className="code-block px-4 py-2 text-lg">
                    {step.code}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="bg-gray-900 text-white py-12 px-4">
      <div style={{ maxWidth: '896px', marginLeft: 'auto', marginRight: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div className="flex flex-wrap justify-center gap-4 mb-8">
          <a
            href={VSCODE_MARKETPLACE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mc-btn mc-btn-green"
          >
            VS Code Marketplace
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mc-btn"
          >
            GitHub
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mc-btn"
          >
            Documentation
          </a>
        </div>

        <p className="text-xl text-gray-400 mb-4 text-center">
          Inspired by{' '}
          <a
            href="https://github.com/overleaf-workshop/Overleaf-Workshop"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-400 hover:text-green-300"
          >
            Overleaf-Workshop
          </a>
        </p>

        <p className="text-lg text-gray-500 text-center">
          MIT License © 2025{' '}
          <a
            href="https://wqzhao.org"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-white"
          >
            Wuqiong Zhao
          </a>
        </p>
      </div>
    </footer>
  )
}

function App() {
  return (
    <div className="min-h-screen w-full">
      <Hero />
      <Features />
      <Steps />
      <Footer />
    </div>
  )
}

export default App
